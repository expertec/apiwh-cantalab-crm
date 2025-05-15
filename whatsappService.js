// whatsappApiService.js

import axios from 'axios';
import dotenv from 'dotenv';
import admin from 'firebase-admin';
import { db } from './firebaseAdmin.js';
dotenv.config();

const TOKEN   = process.env.WHATSAPP_TOKEN;
const PHONEID = process.env.PHONE_NUMBER_ID;
const API_URL = `https://graph.facebook.com/v15.0/${PHONEID}/messages`;

/** Llama a la Cloud API de WhatsApp */
async function callWhatsAppAPI(body) {
  return axios.post(API_URL, body, {
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
}

/** Normaliza teléfono a E.164 sin '+' */
function normalize(phone) {
  let num = String(phone).replace(/\D/g, '');
  if (num.length === 10) num = '52' + num;
  return num;
}

/** Envía un mensaje de texto por WhatsApp y lo guarda en Firestore. */
export async function sendTextMessage(phone, text) {
  const to = normalize(phone);

  // 1) Enviar por API oficial (añadimos `type: 'text'`)
  await callWhatsAppAPI({
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text }
  });

  // 2) Guardar en Firestore
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

/** Envía un mensaje de audio por WhatsApp y lo guarda en Firestore. */
export async function sendAudioMessage(phone, mediaUrl) {
  const to = normalize(phone);

  // 1) Enviar por API oficial
  await callWhatsAppAPI({
    messaging_product: 'whatsapp',
    to,
    type: 'audio',
    audio: { link: mediaUrl }
  });

  // 2) Guardar en Firestore
  const q = await db.collection('leads')
                  .where('telefono', '==', to)
                  .limit(1)
                  .get();
  if (!q.empty) {
    const leadId = q.docs[0].id;
    const msgData = {
      content: '',
      mediaType: 'audio',
      mediaUrl,
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
