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
import { sendTextMessage, sendAudioMessage } from './whatsappService.js';
import { processSequences, generateLetras, sendLetras } from './scheduler.js';

dotenv.config();
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
  console.log('[DEBUG] POST /api/whatsapp/send-message', req.body);
  const { leadId, phone, message } = req.body;
  if (!message || (!leadId && !phone)) {
    return res.status(400).json({ error: 'Faltan message y leadId o phone' });
  }

  try {
    let numero = phone;
    if (leadId) {
      const leadSnap = await db.collection('leads').doc(leadId).get();
      if (!leadSnap.exists) {
        return res.status(404).json({ error: 'Lead no encontrado' });
      }
      numero = leadSnap.data().telefono;
    }

    await sendTextMessage(numero, message);
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
    console.log('[DEBUG] POST /api/whatsapp/send-audio', req.body);
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
  console.log('[DEBUG] GET /webhook verify');
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.send(challenge);
  }
  return res.sendStatus(403);
});

/**
 * Estado de conexión (simple)
 */
app.get('/api/whatsapp/status', async (req, res) => {
  console.log('[DEBUG] GET /api/whatsapp/status');
  try {
    const ok = !!(process.env.WHATSAPP_TOKEN && process.env.PHONE_NUMBER_ID);
    return res.json({ status: ok ? 'Conectado' : 'Desconectado' });
  } catch (err) {
    console.error('Error en status:', err);
    return res.status(500).json({ status: 'Error' });
  }
});

/**
 * Número activo
 */
app.get('/api/whatsapp/number', (req, res) => {
  console.log('[DEBUG] GET /api/whatsapp/number');
  const phone = process.env.PHONE_NUMBER_ID || '';
  if (phone) {
    return res.json({ phone });
  }
  return res.status(500).json({ error: 'PHONE_NUMBER_ID no configurado' });
});

/**  
 * Webhook de WhatsApp: Mensajes entrantes  
 */
app.post('/webhook', async (req, res) => {
  console.log('[DEBUG] POST /webhook', JSON.stringify(req.body).slice(0,200));
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const msg = changes?.value?.messages?.[0];
    if (msg) {
      const from = msg.from;
      const text = msg.text?.body || '';

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
