// server.js

import axios from 'axios';
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
import { sendTextMessage, sendAudioMessage, uploadMedia } from './whatsappService.js';
import { processSequences, generateLetras, sendLetras } from './scheduler.js';

dotenv.config();
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONEID = process.env.PHONE_NUMBER_ID;
const GRAPH_PHONE_URL = `https://graph.facebook.com/v15.0/${PHONEID}`;

const app = express();
const port = process.env.PORT || 3001;
const upload = multer({ dest: path.resolve('./uploads') });
const FieldValue = admin.firestore.FieldValue;

// Middlewares
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf } }));
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
app.post('/api/whatsapp/send-audio', upload.single('audio'), async (req, res) => {
  const { phone } = req.body;
  // Multer deja el archivo sin extensión, vamos a renombrarlo según su mimetype
  const originalPath = req.file.path;
  // Escoge la extensión y MIME que reconoce WhatsApp
  const isOgg = req.file.mimetype === 'audio/ogg' || req.file.mimetype === 'audio/opus';
  const ext      = isOgg ? '.ogg' : '.m4a';
  const mime     = isOgg ? 'audio/ogg' : 'audio/mp4';
  const uploadPath = originalPath + ext;

  // Renombramos el archivo (123abc → 123abc.m4a o .ogg)
  fs.renameSync(originalPath, uploadPath);

  try {
    // 1) Sube el medio y obtiene mediaId
    const mediaId = await uploadMedia(uploadPath, mime);
    // 2) Envía la nota de voz usando ese mediaId
    await sendAudioMessage(phone, mediaId);
    // 3) Limpia el archivo temporal
    fs.unlinkSync(uploadPath);
    return res.json({ success: true });
  } catch (err) {
    console.error('Error enviando audio:', err);
    // Limpieza en caso de error
    try { fs.unlinkSync(uploadPath); } catch {}
    return res.status(500).json({ error: err.message });
  }
});

/**  
 * Webhook de WhatsApp: Verificación  
 */
app.get('/webhook', (req, res) => {
  console.log('[DEBUG] GET /webhook verify');
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
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
    const resp = await axios.get(GRAPH_PHONE_URL, {
      params: { access_token: TOKEN, fields: 'display_phone_number' }
    });
    return res.json({
      status: 'Conectado',
      phone: resp.data.display_phone_number
    });
  } catch (err) {
    console.error('[ERROR] status check failed:', err.response?.data || err.message);
    const code = err.response?.status || 500;
    return res.status(code).json({
      status: 'Desconectado',
      error: err.response?.data?.error?.message || err.message
    });
  }
});

/**
 * Número activo
 */
app.get('/api/whatsapp/number', async (req, res) => {
  console.log('[DEBUG] GET /api/whatsapp/number');
  try {
    const resp = await axios.get(GRAPH_PHONE_URL, {
      params: { access_token: TOKEN, fields: 'display_phone_number' }
    });
    return res.json({ phone: resp.data.display_phone_number });
  } catch (err) {
    console.error('[ERROR] number fetch failed:', err.response?.data || err.message);
    return res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

/**  
 * Webhook de WhatsApp: Mensajes entrantes  
 */
app.post('/webhook', async (req, res) => {
  console.log('[DEBUG] POST /webhook payload:', JSON.stringify(req.body).slice(0,200));
  try {
    const entryChanges = req.body.entry?.flatMap(e => e.changes) || [];
    for (const change of entryChanges) {
      const messages = change.value?.messages || [];
      for (const msg of messages) {
        const from      = msg.from;
        const text      = msg.text?.body || '';
        const mediaType = msg.image ? 'image'
                         : msg.audio ? 'audio'
                         : text      ? 'text'
                         : null;
        const mediaUrl  = msg.image?.url || msg.audio?.url || null;

        // Upsert de lead
        const q = await db.collection('leads')
                          .where('telefono','==', from)
                          .limit(1)
                          .get();
        let leadId;
        if (q.empty) {
          const now     = new Date();
          const cfgSnap = await db.collection('config').doc('appConfig').get();
          const cfg     = cfgSnap.exists ? cfgSnap.data() : {};
          const trigger = cfg.defaultTrigger || 'NuevoLead';

          const newLead = await db.collection('leads').add({
            telefono: from,
            nombre:   msg.pushName || '',
            source:   'WhatsApp',
            fecha_creacion: now,
            estado:   'nuevo',
            etiquetas:[trigger],
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

        // Guardar mensaje
        await db.collection('leads')
                .doc(leadId)
                .collection('messages')
                .add({
                  content:   text,
                  mediaType,
                  mediaUrl,
                  sender:    'lead',
                  timestamp: new Date()
                });
      }
    }
    return res.sendStatus(200);
  } catch (err) {
    console.error('[ERROR] en webhook:', err);
    return res.sendStatus(500);
  }
});

// Scheduler: procesos periódicos
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
