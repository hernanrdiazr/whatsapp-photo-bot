import makeWASocket, { DisconnectReason, useMultiFileAuthState, makeInMemoryStore } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as fs from 'fs';
import AWS from 'aws-sdk';
import dotenv from 'dotenv';
const { google } = require('googleapis');
import express from 'express';
import { MercadoPagoConfig, Payment } from 'mercadopago';
// Load environment variables from .env file
dotenv.config();

// Initialize MercadoPago client
const client = new MercadoPagoConfig({ accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN || '' });
const payment = new Payment(client);

const app = express();
const port = 80;

let sock: any;

// Function to initialize WhatsApp connection
async function initializeWhatsApp() {
    try {
        sock = await connectToWhatsApp();
        console.log('WhatsApp connection initialized successfully');
    } catch (error) {
        console.error('Error connecting to WhatsApp:', error);
        // Retry connection after a delay
        setTimeout(initializeWhatsApp, 5000);
    }
}

// Initialize WhatsApp connection
initializeWhatsApp();

// Webhook route for pix payment
app.use(express.json());
app.post('/', async (req: any, res: any) => {
  // Immediately respond with 200 status
  res.status(200).json({ status: 'success' });

  // Process the webhook data asynchronously
  const { action, data } = req.body;
  
  if (action === 'payment.updated' && data.id) {
    try {
      // Process payment asynchronously with folderKey and phoneNumber from data
      processPayment(data.id );
    } catch (error) {
      console.error('Error scheduling payment processing:', error);
    }
  }
});

// Updated function to handle payment processing with direct data
async function processPayment(paymentId: string) {
  try {
    // Fetch payment details just to verify status
    const paymentInfo = await payment.get({ id: paymentId });
    const {folder_key: folderKey, wn: whatsappNumber} = paymentInfo.metadata;
    
    if (paymentInfo.status === 'approved') {
      
      // Get photos from S3
      const photos = await getPhotosFromS3('your-bucket-name', folderKey);
      
      if (photos && photos.length > 0) {
        await sock.sendMessage(whatsappNumber, { 
          text: `Olá! Muito obrigado pela sua contribuição. Aqui estão todas as suas fotos!` 
        });
        
        for (const photoUrl of photos) {
          await sock.sendMessage(whatsappNumber, { 
            image: { url: photoUrl }
          });
        }
        
        await sock.sendMessage(whatsappNumber, { 
          text: `Esperamos que você goste das fotos! Muito obrigado pela preferência.` 
        });
      }
    }
    else {
      await sock.sendMessage(whatsappNumber, {
        text: `Desculpe-nos, infelizmente, o pagamento não foi aprovado.`
      });
    }
  } catch (error) {
    console.error('Error processing payment:', error);
  }
}

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});


// Google Drive setup with Service Account
const SCOPES = ['https://www.googleapis.com/auth/drive'];
const CREDENTIALS_FILE = 'google_drive_api_credentials.json'; // Your service account JSON file

const auth = new google.auth.GoogleAuth({
  keyFile: CREDENTIALS_FILE,
  scopes: SCOPES,
});

setInterval(() => {
    const memoryUsage = process.memoryUsage();
    console.log(`Memory usage: RSS: ${memoryUsage.rss / 1024 / 1024} MB, Heap Total: ${memoryUsage.heapTotal / 1024 / 1024} MB, Heap Used: ${memoryUsage.heapUsed / 1024 / 1024} MB`);
  }, 5000); // Logs memory usage every 5 seconds

const drive = google.drive({ version: 'v3', auth });

// AWS S3 setup

const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION,
});

// Function to fetch photos from AWS S3 by folder key
async function getPhotosFromS3(bucketName: string, folderKey: string) {
    try {
        const bucket = process.env.AWS_BUCKET_NAME;
        if (!bucket) {
            throw new Error('Bucket name is not defined in environment variables');
        }

        const params = {
            Bucket: bucket,
            Prefix: `customer_${folderKey}`,
        };

        const data = await s3.listObjectsV2(params).promise();


        console.log("Data fetched from S3:", data);


        const photoUrls = data.Contents?.filter((item: any) => item.Key && (item.Key.endsWith('.JPG') || item.Key.endsWith('.png')))
            .map((item: any) => `http://${bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${item.Key}`);

        console.log('Photos fetched:', photoUrls);

        return photoUrls || [];

    } catch (error) {
        if (error instanceof Error) {
            console.error('Error fetching photos from S3:', error.message);
        } else {
            console.error('Error fetching photos from S3:', error);
        }
        return [];
    }
}

//==========================
function gerarPayloadPIX(chavePIX: string , identificador: string, valor: number | null  = null) {
    // Formata o valor para o padrão PIX (opcional, se não for informado, será 0.00)
    const valorFormatado = valor !== null ? valor.toFixed(2) : '0.00';

    // Monta o payload PIX conforme o padrão da Febraban
    const payload = [
        '000201', // Payload Format Indicator
        '26580014BR.GOV.BCB.PIX', // GUI (Identificador do PIX)
        `0136${chavePIX}`, // Chave PIX
        '52040000', // Merchant Category Code (Categoria do estabelecimento)
        '5303986', // Moeda (986 = BRL)
        //`54${valorFormatado.length}${valorFormatado}`, // Valor da transação (opcional)
        '5802BR', // País
        `5921VICENTE ARDITO JUNIOR`, // Nome do beneficiário/identificador
        '6009SAO PAULO', // Cidade do beneficiário
        '62070503***', // Identificador do TXID (opcional)
        '6304' // CRC16 (checksum)
    ].join('');

    // Calcula o CRC16 do payload
    const crc16 = calcularCRC16(payload);
    return payload + crc16;
}

// Função para calcular o CRC16 (obrigatório no padrão PIX)
function calcularCRC16(payload: string) {
    let crc = 0xFFFF;
    for (let i = 0; i < payload.length; i++) {
        crc ^= payload.charCodeAt(i) << 8;
        for (let j = 0; j < 8; j++) {
            crc = (crc & 0x8000) ? (crc << 1) ^ 0x1021 : crc << 1;
        }
    }
    return (crc & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
}

/*
// Exemplo de uso
const chavePIX = '123e4567-e89b-12d3-a456-426614174000'; // Substitua pela chave PIX
const identificador = 'LojaXYZ'; // Substitua pelo identificador
const valor = null; // Opcional, se não for informado, será 0.00

const payloadPIX = gerarPayloadPIX(chavePIX, identificador, valor);
console.log('Payload PIX:', payloadPIX);
*/


async function connectToWhatsApp() {
    // Use multi-file auth state to persist session
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    // Initialize in-memory store for message data
    const store = makeInMemoryStore({});
    store.readFromFile('./baileys_store.json');

    // Save the store state periodically
    setInterval(() => {
        store.writeToFile('./baileys_store.json');
    }, 10_000);

    // Create a new socket connection
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        browser: ['MyApp', 'Chrome', '1.0'], // Custom browser info
        syncFullHistory: true, // Fetch complete history
    });

    // Save credentials when updated
    sock.ev.on('creds.update', saveCreds);

    // Handle connection updates
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;
            const shouldReconnect = reason !== DisconnectReason.loggedOut;

            console.log('Connection closed:', reason, '. Reconnecting:', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('Connection opened successfully!');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const message = m.messages[0];
        if (!message.message || message.key.fromMe) return;
    
        const sender = message.key.remoteJid;
        const text = message.message.conversation || message.message.extendedTextMessage?.text;
    
        console.log(`Received message from ${sender}: ${text}`);
    
        const folderKeyMatch = text?.match(/fid=([\w-]+)/);
        const folderKey = folderKeyMatch ? folderKeyMatch[1] : '';
    
        if (!folderKey) {
            // await sock.sendMessage(sender ?? '', { text: 'No valid folder key found in the message.' });
            return;
        }
    
        const photos = await getPhotosFromS3('your-bucket-name', folderKey);
    
        if (photos.length === 0) {
            await sock.sendMessage(sender ?? '', { text: `Desculpe, ocorreu um problema. Vamos verificar e entraremos em contato.` });
        } else {
            await sock.sendMessage(sender ?? '', { text: `Claro! Aqui você tem uma foto de demonstração. Esperamos que goste. Para receber todas as fotos, incluindo as originais e as processadas com o fundo trocado, clique no link abaixo e escolha um valor para sua contribuição.  O valor que você achar que merecemos pelo nosso trabalho. Muito obrigado!` });
                await sock.sendMessage(sender ?? '', { image: { url: photos[0] }, viewOnce: true  });
            await sock.sendMessage(sender ?? '', { text: `https://v0-new-project-3c6m53cpxsf.vercel.app/?folderKey=${folderKey}&wn=${sender}` });
        }
    });

    // Listen for other events (optional, customize as needed)
    sock.ev.on('chats.update', (chats) => {
        console.log('Chats updated:', chats);
    });

    sock.ev.on('contacts.upsert', (contacts) => {
        console.log('Contacts updated:', contacts);
    });

    return sock;
}


