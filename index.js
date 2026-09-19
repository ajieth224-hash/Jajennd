import WebSocket from 'ws';
globalThis.WebSocket = WebSocket;

import { Client } from 'discord.js-selfbot-v13';
import { Streamer, prepareStream, playStream, Utils } from '@dank074/discord-video-stream';
import express from 'express';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Biar rejection yang tidak tertangkap (mis. dari library streaming) tetap tercetak
// lengkap dengan stack-nya, bukan bikin proses mati diam-diam atau cuma "{}".
process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', (reason && reason.stack) || reason);
});

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
// Default sengaja kecil: instance Render free cuma 512MB RAM, encode 1080p bikin OOM.
const videoHeight = parseInt(process.env.VIDEO_HEIGHT || '480', 10);
const videoFps = parseInt(process.env.VIDEO_FPS || '24', 10);
// Berapa token yang ikut screen share (urut dari Token 1). Tiap stream = 1 proses ffmpeg
// sendiri, jadi di RAM 512MB cukup 1. Token lain tetap join voice & auto-reply AFK.
const screenShareMax = parseInt(process.env.SCREEN_SHARE_MAX || '1', 10);

// --- MODE GAMBAR (jauh lebih enteng dari video) ---
// Isi IMAGE_SOURCE dengan path gambar lokal (mis. "gambar.png", taruh di folder yang
// sama) ATAU link langsung ke gambar (png/jpg/webp). Kalau di-set, ini dipakai dan
// VIDEO_SOURCE diabaikan. Gambar diubah SEKALI jadi klip diam berdurasi panjang
// (IMAGE_HOURS jam), lalu di-stream. Resolusi ikut VIDEO_HEIGHT (rasio 16:9, sisanya hitam).
const imageSource = process.env.IMAGE_SOURCE;
const imageFps = parseInt(process.env.IMAGE_FPS || '5', 10);
const imageHours = parseFloat(process.env.IMAGE_HOURS || '4');
const imageHeight = 2 * Math.round(videoHeight / 2);
const imageWidth = 2 * Math.round((videoHeight * 16) / 9 / 2);

function detectImageExt(buf) {
    if (buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
    if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
    if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
    return null;
}

async function buildImageLoop() {
    let raw;
    if (/^https?:\/\//i.test(imageSource)) {
        const res = await fetch(imageSource);
        if (!res.ok) throw new Error(`Gagal download gambar (HTTP ${res.status})`);
        raw = Buffer.from(await res.arrayBuffer());
    } else {
        raw = fs.readFileSync(imageSource);
    }
    const ext = detectImageExt(raw);
    if (!ext) throw new Error('Format gambar tidak dikenali (pakai png, jpg, atau webp)');

    const imgPath = `/tmp/screen-image.${ext}`;
    const clipPath = '/tmp/screen-clip.mkv';
    const loopPath = '/tmp/screen-loop.mkv';
    fs.writeFileSync(imgPath, raw);

    const clipSecs = 10;
    const totalSecs = Math.max(clipSecs, Math.round(imageHours * 3600));
    const loops = Math.ceil(totalSecs / clipSecs) - 1;
    const vf = `scale=${imageWidth}:${imageHeight}:force_original_aspect_ratio=decrease,` +
        `pad=${imageWidth}:${imageHeight}:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p`;

    // 1) Klip pendek 10 detik: gambar diam + audio senyap (biar pipeline streaming dapat video & audio)
    await execFileAsync('ffmpeg', [
        '-y', '-loglevel', 'error', '-threads', '1',
        '-loop', '1', '-framerate', String(imageFps), '-i', imgPath,
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono',
        '-t', String(clipSecs), '-vf', vf, '-r', String(imageFps),
        '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-crf', '30',
        '-g', String(imageFps * clipSecs),
        '-c:a', 'aac', '-b:a', '16k', '-ar', '48000', '-ac', '1',
        clipPath,
    ]);

    // 2) Diulang tanpa re-encode (-c copy) jadi satu file panjang - hampir tanpa beban CPU/RAM
    await execFileAsync('ffmpeg', [
        '-y', '-loglevel', 'error',
        '-stream_loop', String(loops), '-i', clipPath,
        '-t', String(totalSecs), '-c', 'copy',
        loopPath,
    ]);
    return loopPath;
}

let imageLoopPromise = null;
function getImageLoop() {
    if (!imageLoopPromise) {
        imageLoopPromise = buildImageLoop().catch((e) => {
            imageLoopPromise = null; // biar percobaan berikutnya bikin ulang
            throw e;
        });
    }
    return imageLoopPromise;
}
const screenSource = imageSource || videoSource;

// Kalau stream berhenti sebelum sempat jalan segini lama, dianggap GAGAL (bukan "video selesai").
const MIN_HEALTHY_MS = 30_000;
// Berhenti mencoba lagi setelah gagal beruntun sebanyak ini (biar yt-dlp/YouTube tidak dihajar terus).
const MAX_QUICK_FAILURES = 5;

const AFK_KEYWORDS = ['hey wake up', 'confirm by saying `yes`', 'are you still here'];

// --- Fungsi Bot ---
function startBot(token, index) {
    const client = new Client({ checkUpdate: false });
    const streamer = new Streamer(client);
    let streaming = false;

    async function startScreenShare() {
        if (streaming) return;
        streaming = true;
        const tag = `[Token ${index + 1}]`;
        let failures = 0;

        try {
            while (true) {
                const startedAt = Date.now();
                const ffmpegTail = []; // 20 baris stderr ffmpeg terakhir, dicetak kalau gagal cepat
                let command = null;

                try {
                    console.log(`${tag} Memulai screen share (${imageSource ? 'gambar' : 'video'}): ${screenSource}`);
                    const resolvedSource = imageSource ? await getImageLoop() : await resolveVideoSource(videoSource);
                    const encoderOptions = imageSource
                        ? {
                            width: imageWidth,
                            height: imageHeight,
                            frameRate: imageFps,
                            bitrateVideo: 1000,
                            bitrateVideoMax: 1500,
                            videoCodec: Utils.normalizeVideoCodec('H264'),
                            h26xPreset: 'ultrafast',
                            includeAudio: false, // audio senyap tidak berguna & bikin warning "Frame takes too long to send"
                            // -threads 1 hemat CPU; -g = keyframe tiap ~2 detik biar penonton yang baru gabung langsung lihat gambar
                            customFfmpegFlags: ['-threads', '1', '-g', String(imageFps * 2)],
                        }
                        : {
                            height: videoHeight,
                            frameRate: videoFps,
                            bitrateVideo: 5000,
                            bitrateVideoMax: 7500,
                            videoCodec: Utils.normalizeVideoCodec('H264'),
                            h26xPreset: 'veryfast',
                        };
                    const prepared = prepareStream(resolvedSource, encoderOptions);
                    command = prepared.command;

                    command.on('stderr', (line) => {
                        ffmpegTail.push(line);
                        if (ffmpegTail.length > 20) ffmpegTail.shift();
                    });
                    command.on('error', (err) => {
                        console.error(`${tag} ffmpeg error: ${err.message}`);
                    });

                    await playStream(prepared.output, streamer, { type: 'go-live' });
                    console.log(`${tag} Stream berhenti setelah ${Math.round((Date.now() - startedAt) / 1000)} detik.`);
                } catch (e) {
                    console.error(`${tag} Gagal screen share: ${(e && e.stack) || e}`);
                } finally {
                    try { if (command) command.kill('SIGKILL'); } catch (_) { /* sudah mati */ }
                    try { if (typeof streamer.stopStream === 'function') streamer.stopStream(); } catch (_) { /* abaikan */ }
                }

                const playedMs = Date.now() - startedAt;
                if (playedMs >= MIN_HEALTHY_MS) {
                    failures = 0;
                } else {
                    failures++;
                    console.error(`${tag} Stream mati dalam ${Math.round(playedMs / 1000)} detik (gagal beruntun: ${failures}/${MAX_QUICK_FAILURES}).`);
                    if (ffmpegTail.length) {
                        console.error(`${tag} Output ffmpeg terakhir:\n${ffmpegTail.join('\n')}`);
                    }
                    if (failures >= MAX_QUICK_FAILURES) {
                        console.error(`${tag} Menyerah screen share setelah ${failures} kali gagal. Bot tetap di voice & auto-reply AFK.`);
                        break;
                    }
                }

                if (!videoLoop && failures === 0) break; // sekali putar, sudah selesai normal
                await sleep(failures ? Math.min(120_000, 5_000 * 2 ** (failures - 1)) : 1_000);
            }
        } finally {
            streaming = false;
        }
    }

    // --- Pastikan akun TIDAK self-mute / self-deaf ---
    // Op 4 = Voice State Update (perintah gateway Discord). Channel yang sama, jadi
    // cuma mengubah status mute/deaf, tidak pindah/rejoin channel.
    let joinedVoice = false;
    let lastVoiceFix = 0;

    function sendUnmuteUndeaf() {
        const d = { guild_id: guildId, channel_id: channelId, self_mute: false, self_deaf: false };
        try {
            if (client.ws && typeof client.ws.broadcast === 'function') {
                client.ws.broadcast({ op: 4, d });
            } else if (typeof streamer.sendOpcode === 'function') {
                streamer.sendOpcode(4, d);
            } else {
                console.error(`[Token ${index + 1}] Tidak bisa set status mute/deaf: tidak ada cara kirim voice state.`);
            }
        } catch (e) {
            console.error(`[Token ${index + 1}] Gagal set status mute/deaf: ${(e && e.message) || e}`);
        }
    }

    // Kalau akun ke-mute/deaf sendiri (mis. dari HP/PC lain), matikan lagi.
    // Mute/deaf dari server (admin) tidak bisa diubah dari sini, jadi tidak dicek.
    client.on('voiceStateUpdate', (_old, next) => {
        try {
            if (!joinedVoice || !client.user || !next || next.id !== client.user.id) return;
            if (String(next.channelId) !== String(channelId)) return; // jangan paksa join ulang kalau sudah keluar
            if (!next.selfMute && !next.selfDeaf) return;
            const now = Date.now();
            if (now - lastVoiceFix < 5000) return; // jangan spam
            lastVoiceFix = now;
            console.log(`[Token ${index + 1}] Terdeteksi self-mute/deaf, dimatikan lagi.`);
            sendUnmuteUndeaf();
        } catch (_) { /* abaikan */ }
    });

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
            joinedVoice = true;
            sendUnmuteUndeaf(); // pastikan tidak mute/deaf sejak awal
        } catch (e) {
            console.error(`[Token ${index + 1}] Gagal masuk Voice: ${e.message}`);
            return;
        }

        if (screenSource && index < screenShareMax) {
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
