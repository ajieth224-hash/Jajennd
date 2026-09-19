import WebSocket from 'ws';
globalThis.WebSocket = WebSocket;

import { Client } from 'discord.js-selfbot-v13';
import { Streamer, prepareStream, playStream, Utils } from '@dank074/discord-video-stream';
import express from 'express';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// youtu.be/youtube.com links are web pages, not direct video files - ffmpeg
// can't read them as-is. yt-dlp resolves the actual direct media URL first.
// Re-resolved fresh each time startScreenShare() runs (including on loop),
// since the resolved URL expires after a while.
const YOUTUBE_PATTERN = /(youtube\.com|youtu\.be)/i;

// Opsional: kalau YouTube nolak dengan "Sign in to confirm you're not a bot",
// isi YOUTUBE_COOKIES di environment variable dengan cookie dari akun YouTube
// yang sudah login. Boleh format Netscape ATAU JSON array (hasil export
// ekstensi semacam Cookie-Editor) - otomatis dikonversi kalau perlu, soalnya
// yt-dlp cuma mau baca format Netscape.
function toNetscapeCookieFile(raw) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('[')) return raw; // sudah bukan JSON, anggap sudah format Netscape

    let cookies;
    try {
        cookies = JSON.parse(trimmed);
    } catch (e) {
        return raw; // bukan JSON valid juga - biarkan apa adanya, biar yt-dlp yang komplain
    }

    const lines = ['# Netscape HTTP Cookie File'];
    for (const c of cookies) {
        if (!c || !c.name || !c.domain) continue;
        const domain = c.domain;
        const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
        const path = c.path || '/';
        const secure = c.secure ? 'TRUE' : 'FALSE';
        const expires = c.expirationDate ? Math.floor(c.expirationDate) : 0;
        lines.push([domain, includeSubdomains, path, secure, expires, c.name, c.value].join('\t'));
    }
    return lines.join('\n') + '\n';
}

let youtubeCookiesPath = null;
if (process.env.YOUTUBE_COOKIES) {
    youtubeCookiesPath = '/tmp/youtube-cookies.txt';
    fs.writeFileSync(youtubeCookiesPath, toNetscapeCookieFile(process.env.YOUTUBE_COOKIES));
}

async function resolveVideoSource(source) {
    if (!YOUTUBE_PATTERN.test(source)) return source;
    try {
        const args = ['-f', 'best[ext=mp4]/best', '-g', source];
        if (youtubeCookiesPath) args.push('--cookies', youtubeCookiesPath);
        const { stdout } = await execFileAsync('yt-dlp', args);
        const directUrl = stdout.trim().split('\n')[0];
        if (!directUrl) throw new Error('yt-dlp tidak mengembalikan URL apa pun');
        return directUrl;
    } catch (e) {
        throw new Error(`Gagal resolve link YouTube lewat yt-dlp: ${e.message}`);
    }
}

// --- Dummy Web Server (buat Render, biar ada yang "dengerin" di sebuah port) ---
const app = express();
app.get('/', (_req, res) => res.send('Bot Voice Joiner, Auto-Reply AFK & Screen Share Sedang Berjalan!'));
app.listen(process.env.PORT || 8080, '0.0.0.0');

console.log('=================================================');
console.log('MULTI TOKEN VOICE JOINER & AFK AUTO-REPLY + SCREEN SHARE');
console.log('=================================================');

// --- Ambil Token ---
let tokens;
try {
    tokens = fs.readFileSync('token.txt', 'utf-8').split('\n').map((t) => t.trim()).filter(Boolean);
} catch (e) {
    console.error('File token.txt tidak ditemukan!');
    process.exit(1);
}
if (tokens.length === 0) {
    console.error('Token kosong!');
    process.exit(1);
}

// --- Ambil ID & Konfigurasi dari Environment Variables ---
const guildId = process.env.GUILD_ID;
const channelId = process.env.CHANNEL_ID;

if (!guildId || !channelId) {
    console.error('GAGAL: GUILD_ID atau CHANNEL_ID belum disetting di Render!');
    process.exit(1);
}

// Video yang mau di-share lewat screen share (Go Live). Bisa path file lokal
// (taruh file-nya di folder yang sama, contoh: "video.mp4") ATAU link
// langsung ke file video online. Kosongkan/jangan di-set kalau tidak mau
// screen share - bot akan tetap join voice & auto-reply AFK seperti biasa.
const videoSource = process.env.VIDEO_SOURCE;
const videoLoop = (process.env.VIDEO_LOOP || 'true').toLowerCase() === 'true';
const videoHeight = parseInt(process.env.VIDEO_HEIGHT || '1080', 10);
const videoFps = parseInt(process.env.VIDEO_FPS || '30', 10);

const AFK_KEYWORDS = ['hey wake up', 'confirm by saying `yes`', 'are you still here'];

// --- Fungsi Bot ---
function startBot(token, index) {
    const client = new Client({ checkUpdate: false });
    const streamer = new Streamer(client);
    let streaming = false;

    async function startScreenShare() {
        if (streaming) return;
        streaming = true;
        try {
            console.log(`[Token ${index + 1}] Memulai screen share: ${videoSource}`);
            const resolvedSource = await resolveVideoSource(videoSource);
            const { command, output } = prepareStream(resolvedSource, {
                height: videoHeight,
                frameRate: videoFps,
                bitrateVideo: 5000,
                bitrateVideoMax: 7500,
                videoCodec: Utils.normalizeVideoCodec('H264'),
                h26xPreset: 'veryfast',
            });

            command.on('error', (err) => {
                console.error(`[Token ${index + 1}] Error ffmpeg saat screen share: ${err.message}`);
                streaming = false;
            });

            await playStream(output, streamer, { type: 'go-live' });
            console.log(`[Token ${index + 1}] Video selesai.`);
            streaming = false;
            if (videoLoop) {
                await startScreenShare();
            }
        } catch (e) {
            console.error(`[Token ${index + 1}] Gagal memulai screen share: ${e.message}`);
            streaming = false;
        }
    }

    client.on('ready', async () => {
        console.log(`[Token ${index + 1}] Sesi divalidasi, mencoba masuk Voice...`);
        try {
            const joinTimeout = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('joinVoice() timed out after 45s - kemungkinan macet di handshake DAVE')), 45000);
            });
            await Promise.race([
                streamer.joinVoice(guildId, channelId, { selfMute: false, selfDeaf: false }),
                joinTimeout,
            ]);
            console.log(`[Token ${index + 1}] Berhasil masuk Voice Channel.`);
        } catch (e) {
            console.error(`[Token ${index + 1}] Gagal masuk Voice: ${e.message}`);
            return;
        }

        if (videoSource) {
            startScreenShare();
        }
    });

    client.on('messageCreate', async (message) => {
        // SYARAT: hanya proses pesan di dalam Channel yang dimasuki bot
        if (String(message.channel.id) !== String(channelId)) return;

        let fullText = (message.content || '').toLowerCase();
        for (const embed of message.embeds) {
            fullText += ' ' + (embed.description || '').toLowerCase();
            fullText += ' ' + (embed.title || '').toLowerCase();
        }

        // Deteksi jika pesan berisi kata kunci AFK Check
        if (AFK_KEYWORDS.some((keyword) => fullText.includes(keyword))) {
            console.log(`[Token ${index + 1}] Peringatan AFK di channel ini terdeteksi!`);
            await new Promise((r) => setTimeout(r, 2000)); // Jeda agar natural
            try {
                await message.channel.send('yes');
                console.log(`[Token ${index + 1}] Berhasil membalas 'yes' ke bot musik.`);
            } catch (e) {
                console.error(`[Token ${index + 1}] Gagal membalas pesan: ${e.message}`);
            }
        }
    });

    const login = () => {
        client.login(token).catch((e) => {
            console.error(`[Token ${index + 1}] Gagal login (${e.message}).`);
            console.error(`[Token ${index + 1}] Reconnect 5 detik...`);
            setTimeout(login, 5000);
        });
    };

    client.on('disconnect', () => {
        console.error(`[Token ${index + 1}] Terputus.`);
        console.error(`[Token ${index + 1}] Reconnect 5 detik...`);
        setTimeout(login, 5000);
    });

    login();
}

// --- Eksekusi ---
tokens.forEach((token, i) => {
    setTimeout(() => startBot(token, i), i * 3000);
});
