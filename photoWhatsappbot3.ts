import makeWASocket, { DisconnectReason, useMultiFileAuthState, makeInMemoryStore } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as fs from 'fs';
import AWS from 'aws-sdk';
import dotenv from 'dotenv';
import { OpenAI } from 'openai';  // Import OpenAI SDK
const { google } = require('googleapis');

// Load environment variables from .env file
dotenv.config();

// AWS S3 setup
const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION,
});

// Initialize OpenAI API
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY, // Add your OpenAI API key here
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

// Function to connect to OpenAI API (ChatGPT)
async function getChatGPTResponse(userMessage: string): Promise<string | null> {
    const response = await openai.chat.completions.create({
        messages: [{ role: 'user', content: userMessage }],
        model: 'gpt-4o',  // Use GPT-4 model
    });
    return response.choices[0].message.content;
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
            // Send ChatGPT response to user if any other message without the initial message with the folderId 
            if (text) {
                const chatResponse = await getChatGPTResponse(text);
                if (chatResponse) {
                    await sock.sendMessage(sender ?? '', { text: chatResponse });
                }
            } 
            return;
        }
    
        const photos = await getPhotosFromS3('your-bucket-name', folderKey);
    
        if (photos.length === 0) {
            await sock.sendMessage(sender ?? '', { text: `Não encontramos fotos para o cupom: ${folderKey}` });
        } else {
            await sock.sendMessage(sender ?? '', { text: `Claro! Aqui estão as fotos que você pediu. Esperamos que você goste delas. Não esqueça de apoiar nosso trabalho.` });
            for (const photo of photos) {
                await sock.sendMessage(sender ?? '', { image: { url: photo } });
            }
            await sock.sendMessage(sender ?? '', { text: `Um abraço para você. Não deixe de nos apoiar.` });
            await sock.sendMessage(sender ?? '', { text: `Aqui nosso PIX. Você pode copiar e colar no seu aplicativo do banco. Você escolhe o valor. Muito obrigado` });
            await sock.sendMessage(sender ?? '', { text: `00020126580014BR.GOV.BCB.PIX0136e7ea3b26-dd31-4c43-8ed7-6cd4f6c69abc5204000053039865802BR5921VICENTE ARDITO JUNIOR6009SAO PAULO62070503***63042A87` });
            await sock.sendMessage(sender ?? '', { text: `Por favor, nos informe o valor que contribuiu para que possamos registrar. Não tem valor certo, você é quem escolhe o valor de acordo com sua avaliação. Pode ser 10, 20, 100, 200... no mάximo R$ 5.000 ! 😊🤣🫣.. Quanto você quiser e puder.  😊🙏💙` });

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