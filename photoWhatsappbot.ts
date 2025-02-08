import makeWASocket, { DisconnectReason, useMultiFileAuthState, makeInMemoryStore } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as fs from 'fs';
import AWS from 'aws-sdk';
import dotenv from 'dotenv';
const { google } = require('googleapis');

// Load environment variables from .env file
dotenv.config();

// Google Drive setup with Service Account
const SCOPES = ['https://www.googleapis.com/auth/drive'];
const CREDENTIALS_FILE = 'google_drive_api_credentials.json'; // Your service account JSON file

const auth = new google.auth.GoogleAuth({
  keyFile: CREDENTIALS_FILE,
  scopes: SCOPES,
});

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
        const bucket = process.env.BUCKET_NAME;
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
            .map((item: any) => `https://${bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${item.Key}`);

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
    sock.ev.on('connection.update', (update) => {
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
            await sock.sendMessage(sender ?? '', { text: 'No valid folder key found in the message.' });
            return;
        }
    
        const photos = await getPhotosFromS3('your-bucket-name', folderKey);
    
        if (photos.length === 0) {
            await sock.sendMessage(sender ?? '', { text: `No photos found for folder key: ${folderKey}` });
        } else {
            await sock.sendMessage(sender ?? '', { text: `Claro! Aqui você tem as fotos. Espero que você goste deles. Não se esqueça de apoiar nosso trabalho.` });
            for (const photo of photos) {
                await sock.sendMessage(sender ?? '', { image: { url: photo } });
            }
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

// Run the connection
connectToWhatsApp()
    .then(() => console.log('WhatsApp bot is running!'))
    .catch((err) => console.error('Failed to start bot:', err));
