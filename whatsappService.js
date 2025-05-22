// whatsappService.js

import axios from 'axios';
import dotenv from 'dotenv';
import { db } from './firebaseAdmin.js';

dotenv.config();

// Variables para plantillas
const WABA_API_URL             = process.env.WABA_API_URL            || 'https://graph.facebook.com/v22.0';
const WABA_BUSINESS_ACCOUNT_ID = process.env.WABA_BUSINESS_ACCOUNT_ID;
const TOKEN   = process.env.WHATSAPP_TOKEN;
const PHONEID = process.env.PHONE_NUMBER_ID;
// Base URL para todas las llamadas (sin “/messages”)



// Para enviar mensajes (usa el phone_number_id)
const PHONE_API_BASE = `${process.env.WABA_API_URL}/${process.env.PHONE_NUMBER_ID}`;

// Para gestión de plantillas (usa el business_account_id)
const WABA_API_BASE  = `${process.env.WABA_API_URL}/${process.env.WABA_BUSINESS_ACCOUNT_ID}`;

/** Normaliza teléfono a E.164 sin '+' */
function normalize(phone) {
  let num = String(phone).replace(/\D/g, '');
  if (num.length === 10) num = '52' + num;
  return num;
}

/** Llama a la WhatsApp Cloud API */
async function callWhatsAppAPI(path, body, config = {}) {

  const url = PHONE_API_BASE + path;
  console.log(`[WA API] POST ${path}:`, body);

  const axiosConfig = {
    params: { access_token: TOKEN },
    headers: {
      'Content-Type': 'application/json',
      ...(config.headers || {}),
    },
    ...config,
  };

  try {
    const resp = await axios.post(url, body, axiosConfig);
    console.log(`[WA API] ${path} respondió:`, resp.data);
    return resp.data;
  } catch (err) {
    console.error(`[WA API][ERROR] ${path}:`, err.response?.data || err.message);
    throw err;
  }
}

/** Envía un mensaje de texto por WhatsApp y lo guarda en Firestore. */
export async function sendTextMessage(phone, text) {
  const to = normalize(phone);
  await callWhatsAppAPI('/messages', {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text }
  });

  // Guardar en Firestore
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
    await db.collection('leads').doc(leadId).collection('messages').add(msgData);
    await db.collection('leads').doc(leadId).update({ lastMessageAt: msgData.timestamp });
  }
}

/** Envía un mensaje de audio (ID o URL) por WhatsApp y lo guarda en Firestore. */
export async function sendAudioMessage(phone, media) {
  const to = normalize(phone);
  const audioField = media.startsWith('http')
    ? { link: media }
    : { id: media };

  await callWhatsAppAPI('/messages', {
    messaging_product: 'whatsapp',
    to,
    type: 'audio',
    audio: audioField
  });

  // Guardar en Firestore
  const q = await db.collection('leads')
                  .where('telefono', '==', to)
                  .limit(1)
                  .get();
  if (!q.empty) {
    const leadId = q.docs[0].id;
    const msgData = {
      content:   '',
      mediaType: 'audio',
      mediaId:   media,
      sender:    'business',
      timestamp: new Date()
    };
    await db.collection('leads').doc(leadId).collection('messages').add(msgData);
    await db.collection('leads').doc(leadId).update({ lastMessageAt: msgData.timestamp });
  }
}

/** Envía un mensaje de vídeo (ID o URL) por WhatsApp y lo guarda en Firestore. */
export async function sendVideoMessage(phone, media) {
    const to = normalize(phone);
    const videoField = media.startsWith('http')
      ? { link: media }
      : { id: media };
  
    await callWhatsAppAPI('/messages', {
      messaging_product: 'whatsapp',
      to,
      type: 'video',
      video: videoField
    });

    
  
    // Guardar en Firestore
    const q = await db.collection('leads')
                    .where('telefono', '==', to)
                    .limit(1)
                    .get();
    if (!q.empty) {
      const leadId = q.docs[0].id;
      const msgData = {
        content:   '',
        mediaType: 'video',
        mediaUrl:  media,
        sender:    'business',
        timestamp: new Date()
      };
      await db.collection('leads').doc(leadId).collection('messages').add(msgData);
      await db.collection('leads').doc(leadId).update({ lastMessageAt: msgData.timestamp });
    }
  }

  /**
 * Obtiene las plantillas registradas en tu WhatsApp Business Account
 */

  export async function listTemplates() {
    if (!WABA_API_BASE || !TOKEN) {
      throw new Error('Revisa WABA_API_BASE y WHATSAPP_TOKEN en tu .env');
    }
  
    const url = `${WABA_API_BASE}/message_templates`;
    let all = [], after = null;
  
    do {
      const res = await axios.get(url, {
        params: {
          access_token: TOKEN,
          status: 'APPROVED',
          fields: 'name,language,components',
          limit: 50,
          ...(after && { after })
        }
      });
      console.log('📋 RAW TEMPLATES RESPONSE:', res.data);
      all = all.concat(res.data.data || []);
      after = res.data.paging?.cursors?.after;
    } while (after);
  
    return all;
  }
  

  
