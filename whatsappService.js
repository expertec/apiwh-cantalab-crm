// whatsappApiService.js

import axios from 'axios';
import dotenv from 'dotenv';
import admin from 'firebase-admin';
import { db } from './firebaseAdmin.js';
dotenv.config();

const TOKEN   = process.env.WHATSAPP_TOKEN;
const PHONEID = process.env.PHONE_NUMBER_ID;
const API_URL = `https://graph.facebook.com/v15.0/${PHONEID}/messages`;


/** Normaliza teléfono a E.164 sin '+' */
function normalize(phone) {
  let num = String(phone).replace(/\D/g, '');
  if (num.length === 10) num = '52' + num;
  return num;
}

/** Envía un mensaje de texto por WhatsApp y lo guarda en Firestore. */
export async function sendTextMessage(phone, text) {
  const to = normalize(phone);
  console.log('[WA SERVICE] sendTextMessage a:', to, 'texto:', text);
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


async function callWhatsAppAPI(body) {
  console.log('[WA API] Enviando a Graph API:', JSON.stringify(body));
  try {
    const resp = await axios.post(API_URL, body, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    console.log('[WA API] Graph API respondió:', resp.data);
    return resp.data;
  } catch (err) {
    console.error('[WA API][ERROR] Fallo Graph API:', err.response?.data || err.message);
    throw err;
  }
}


/** Envía un mensaje de audio por WhatsApp y lo guarda en Firestore. */
/** Envía un mensaje de audio (ID o URL) por WhatsApp y lo guarda en Firestore. */
export async function sendAudioMessage(phone, media) {
  const to = normalize(phone);

  // 1) Enviar la nota de voz: si media es URL, usa link; si no, id
  const audioField = media.startsWith('http')
    ? { link: media }
    : { id: media };

  await callWhatsAppAPI('/messages', {
    messaging_product: 'whatsapp',
    to,
    type: 'audio',
    audio: audioField
  });

  // 2) Guardado en Firestore igual que antes...
  const q = await db
    .collection('leads')
    .where('telefono', '==', to)
    .limit(1)
    .get();

  if (!q.empty) {
    const leadId = q.docs[0].id;
    const msgData = {
      content:   '',            
      mediaType: 'audio',
      mediaId:   media,         // puede ser ID o URL
      sender:    'business',
      timestamp: new Date()
    };
    await db.collection('leads').doc(leadId).collection('messages').add(msgData);
    await db.collection('leads').doc(leadId).update({ lastMessageAt: msgData.timestamp });
  }
}