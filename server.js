// server.js
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import cron from 'node-cron';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import admin from 'firebase-admin';
import { db } from './firebaseAdmin.js';
import { sendTextMessage, sendAudioMessage } from './whatsappApiService.js';
import { processSequences, generateLetras, sendLetras } from './scheduler.js';

dotenv.config();
// Dile a fluent-ffmpeg dónde está el binario
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
const port = process.env.PORT || 3001;
const upload = multer({ dest: path.resolve('./uploads') });
const FieldValue = admin.firestore.FieldValue;

// Middlewares
app.use(cors());
app.use(bodyParser.json());

/**  
 * Endpoint para enviar mensaje de texto  
 */
app.post('/api/whatsapp/send-message', async (req, res) => {
  const { leadId, message } = req.body;
  if (!leadId || !message) {
    return res.status(400).json({ error: 'Faltan leadId o message en el body' });
  }

  try {
    const leadSnap = await db.collection('leads').doc(leadId).get();
    if (!leadSnap.exists) {
      return res.status(404).json({ error: 'Lead no encontrado' });
    }
    const { telefono } = leadSnap.data();
    await sendTextMessage(telefono, message);
    return res.json({ success: true });
  } catch (err) {
    console.error('Error enviando texto:', err);
    return res.status(500).json({ error: err.message });
  }
});

/**  
 * Endpoint para enviar nota de voz  
 */
app.post(
  '/api/whatsapp/send-audio',
  upload.single('audio'),
  async (req, res) => {
    const { phone } = req.body;
    const uploadPath = req.file.path;
    const m4aPath = `${uploadPath}.m4a`;

    try {
      // 1) Transcodifica a M4A (AAC)
      await new Promise((resolve, reject) => {
        ffmpeg(uploadPath)
          .outputOptions(['-c:a aac', '-vn'])
          .toFormat('mp4')
          .save(m4aPath)
          .on('end', resolve)
          .on('error', reject);
      });

      // 2) Envía la nota de voz
      await sendAudioMessage(phone, m4aPath);

      // 3) Limpia archivos
      fs.unlinkSync(uploadPath);
      fs.unlinkSync(m4aPath);

      return res.json({ success: true });
    } catch (err) {
      console.error('Error enviando audio:', err);
      try { fs.unlinkSync(uploadPath); } catch {}
      try { fs.unlinkSync(m4aPath); } catch {}
      return res.status(500).json({ error: err.message });
    }
  }
);

/**  
 * Webhook de WhatsApp: Verificación  
 */
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.send(challenge);
  }
  return res.sendStatus(403);
});

/**  
 * Webhook de WhatsApp: Mensajes entrantes  
 */
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const msg = changes?.value?.messages?.[0];
    if (msg) {
      const from = msg.from;              // e.g. "521234567890"
      const text = msg.text?.body || '';  // texto si existe
      // Para media: msg.image?.id, msg.audio?.id, etc. tendrás que descargar con la Cloud API.

      // 1) Upsert de lead
      const q = await db.collection('leads')
                        .where('telefono','==', from)
                        .limit(1)
                        .get();
      let leadId;
      if (q.empty) {
        const now = new Date();
        const cfgSnap = await db.collection('config').doc('appConfig').get();
        const cfg = cfgSnap.exists ? cfgSnap.data() : {};
        const trigger = cfg.defaultTrigger || 'NuevoLead';

        const newLead = await db.collection('leads').add({
          telefono: from,
          nombre: msg.pushName || '',
          source: 'WhatsApp',
          fecha_creacion: now,
          estado: 'nuevo',
          etiquetas: [trigger],
          secuenciasActivas: [{ trigger, startTime: now.toISOString(), index: 0 }],
          unreadCount: 1,
          lastMessageAt: now
        });
        leadId = newLead.id;
      } else {
        leadId = q.docs[0].id;
        // Incrementa contador
        await db.collection('leads').doc(leadId).update({
          unreadCount: FieldValue.increment(1),
          lastMessageAt: new Date()
        });
      }

      // 2) Guardar mensaje en subcolección
      const msgData = {
        content: text,
        mediaType: text ? 'text' : null,
        mediaUrl: null,
        sender: 'lead',
        timestamp: new Date()
      };
      await db.collection('leads').doc(leadId)
              .collection('messages').add(msgData);
    }
    return res.sendStatus(200);
  } catch (err) {
    console.error('Error en webhook:', err);
    return res.sendStatus(500);
  }
});

// Scheduler: tus procesos periódicos
cron.schedule('* * * * *', () => {
  processSequences().catch(err => console.error('Error en processSequences:', err));
});
cron.schedule('* * * * *', () => {
  generateLetras().catch(err => console.error('Error en generateLetras:', err));
});
cron.schedule('* * * * *', () => {
  sendLetras().catch(err => console.error('Error en sendLetras:', err));
});

// Arranca el servidor
app.listen(port, () => {
  console.log(`Servidor corriendo en puerto ${port}`);
});
