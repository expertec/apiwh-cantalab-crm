// whatsappApiService.js
import axios from 'axios';
 import dotenv from 'dotenv';

import admin from 'firebase-admin';
import { db } from './firebaseAdmin.js';
import FormData from 'form-data';
import fs from 'fs';

dotenv.config();


const TOKEN   = process.env.WHATSAPP_TOKEN;
const PHONEID = process.env.PHONE_NUMBER_ID;
// Base URL (sin “/messages” al final)
const API_BASE = `https://graph.facebook.com/v15.0/${PHONEID}`;


/** Normaliza teléfono a E.164 sin '+' */
function normalize(phone) {
  let num = String(phone).replace(/\D/g, '');
  if (num.length === 10) num = '52' + num;
  return num;
}

/** Envía un mensaje de texto por WhatsApp y lo guarda en Firestore. */
export async function sendTextMessage(phone, text) {
  const to = normalize(phone);

  // 1) Enviar el texto
  await callWhatsAppAPI('/messages', {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text }
  });

  // 2) Guardar en Firestore bajo sender 'business'
  const q = await db.collection('leads')
                    .where('telefono', '==', to)
                    .limit(1)
                    .get();
  if (!q.empty) {
    const leadId = q.docs[0].id;
    const msgData = {
      content: text,
      sender: 'business',
      timestamp: new Date()
    };
    await db.collection('leads')
            .doc(leadId)
            .collection('messages')
            .add(msgData);
    await db.collection('leads')
            .doc(leadId)
            .update({ lastMessageAt: msgData.timestamp });
  }
}


/** Llama a la WhatsApp Cloud API en la ruta `path` (ej: '/messages' o '/media') */
async function callWhatsAppAPI(path, body, config = {}) {
    const url = API_BASE + path;
    console.log(`[WA API] POST ${path}:`, body);
    try {
      const resp = await axios.post(url, body, {
        params: { access_token: TOKEN },
        ...config
      });
      console.log(`[WA API] ${path} respondió:`, resp.data);
      return resp.data;
    } catch (err) {
      console.error(`[WA API][ERROR] ${path}:`, err.response?.data || err.message);
      throw err;
    }
  }

  async function uploadMedia(filePath, mimeType) {
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath));
    form.append('type', mimeType);
    form.append('messaging_product', 'whatsapp');   // <— aquí
    const data = await callWhatsAppAPI('/media', form, {
      headers: form.getHeaders()
    });
    return data.id;
  }

/** Envía un mensaje de audio por WhatsApp y lo guarda en Firestore. */
export async function sendAudioMessage(phone, mediaId) {
  const to = normalize(phone);

  // 1) Enviar la nota de voz usando mediaId
  await callWhatsAppAPI('/messages', {
    messaging_product: 'whatsapp',
    to,
    type: 'audio',
    audio: { id: mediaId }
  });
  // 2) Guardar en Firestore bajo sender 'business'
  const q = await db
    .collection('leads')
    .where('telefono', '==', to)
    .limit(1)
    .get();

  if (!q.empty) {
    const leadId = q.docs[0].id;
    const msgData = {
      content:   '',            // no hay cuerpo de texto
      mediaType: 'audio',       // tipo de medio
      mediaId,                  // almacenamos el ID para futuras referencias
      sender:    'business',
      timestamp: new Date()
    };

    // Añade al historial de mensajes
    await db
      .collection('leads')
      .doc(leadId)
      .collection('messages')
      .add(msgData);

    // Actualiza la última fecha de mensaje
    await db
      .collection('leads')
      .doc(leadId)
      .update({ lastMessageAt: msgData.timestamp });
  }
}

export { uploadMedia };