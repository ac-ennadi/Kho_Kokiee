const fs = require('fs');
const { Client, GatewayIntentBits, ActivityType, ChannelType, PermissionsBitField, AuditLogEvent } = require('discord.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

try {
  const { generateDependencyReport } = require('@discordjs/voice');
  console.log('[Voice Dependencies]\n' + generateDependencyReport());
} catch (e) {
  console.warn(`[Voice] Could not generate dependency report: ${e.message}`);
}

// Prefer system ffmpeg (installed in Docker) and fallback to ffmpeg-static
let ffmpegPathString = fs.existsSync('/usr/bin/ffmpeg') ? '/usr/bin/ffmpeg' : null;
if (!ffmpegPathString) {
  try {
    ffmpegPathString = require('ffmpeg-static');
  } catch (e) {
    console.warn(`[Music] ffmpeg-static unavailable: ${e.message}`);
  }
}
if (ffmpegPathString) {
  const path = require('path');
  const ffmpegDir = path.dirname(ffmpegPathString);
  process.env.PATH = `${ffmpegDir}${path.delimiter}${process.env.PATH || ''}`;
  console.log(`[Music] FFmpeg ready: ${ffmpegPathString}`);
}

let DisTube = null;
let YouTubePlugin = null;
let YtDlpPlugin = null;
let SoundCloudPlugin = null;

try { DisTube = require('distube').DisTube; } catch (e) { console.error(`[Music] Could not load DisTube: ${e.message}`); }
try { YouTubePlugin = require('@distube/youtube').YouTubePlugin; } catch (e) { console.error(`[Music] Could not load YouTube plugin: ${e.message}`); }
try { YtDlpPlugin = require('@distube/yt-dlp').YtDlpPlugin; } catch (e) { console.error(`[Music] Could not load yt-dlp plugin: ${e.message}`); }
try { SoundCloudPlugin = require('@distube/soundcloud').SoundCloudPlugin; } catch (e) { console.warn(`[Music] SoundCloud plugin unavailable: ${e.message}`); }

// Railway's YouTube requests can be blocked with BOT_CHECK, so prefer
// SoundCloud for searches. Keep YouTube as a second search source and yt-dlp
// last for links it can extract.
const plugins = [];
if (SoundCloudPlugin) plugins.push(new SoundCloudPlugin());
if (YouTubePlugin) plugins.push(new YouTubePlugin());
if (YtDlpPlugin) plugins.push(new YtDlpPlugin());

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  presence: {
    status: 'online',
    activities: [{ name: 'for new members', type: ActivityType.Watching }],
  },
});

let distube = null;
if (DisTube) {
  try {
    distube = new DisTube(client, {
      plugins,
      emitNewSongOnly: true,
      ffmpeg: { path: ffmpegPathString || 'ffmpeg' },
    });
  } catch (e) {
    console.error(`[Music] Could not initialize DisTube: ${e.stack || e.message}`);
  }
}

// FFmpeg diagnostics often contain expiring, signed media URLs. Keep the
// useful stderr while redacting those URLs before they reach Railway logs.
function redactMediaUrls(value) {
  return String(value).replace(/https?:\/\/[^\s"'<>]+/gi, (rawUrl) => {
    try {
      const parsed = new URL(rawUrl);
      return `${parsed.origin}${parsed.pathname}[query-redacted]`;
    } catch {
      return '[media-url-redacted]';
    }
  });
}

const ffmpegDebugCounts = new Map();
if (distube) {
  distube.on('ffmpegDebug', (debug) => {
    const message = redactMediaUrls(debug);
    const processId = message.match(/\[(\d{8,})\]/)?.[1] || 'unknown';
    const count = ffmpegDebugCounts.get(processId) || 0;
    if (count < 25) {
      console.warn(`[Music][FFmpeg] ${message}`);
      ffmpegDebugCounts.set(processId, count + 1);
    } else if (count === 25) {
      console.warn(`[Music][FFmpeg] Suppressing further FFmpeg output for process ${processId}.`);
      ffmpegDebugCounts.set(processId, count + 1);
    }
  });

  distube.on('playSong', (queue, song) => {
    if (queue && queue.textChannel) {
      queue.textChannel.send(`🎶 Daba kayn-playi: \`${song.name}\``).catch(() => {});
    }
    // Music can be the first action that joins the bot to voice. Keep the
    // receiver ready so it can answer once playback ends.
    try {
      const guild = client.guilds.cache.get(queue.id);
      const voice = guild && distube.voices.get(guild.id);
      if (voice) {
        voice.setSelfDeaf(false).catch(error => console.warn(`[Voice Listen] Could not enable receiving: ${error.message}`));
        listenInVoiceChannel(guild, voice.connection, queue.textChannel);
      }
    } catch (error) {
      console.warn(`[Voice Listen] Could not attach receiver: ${error.message}`);
    }
  });

  distube.on('addSong', (queue, song) => {
    if (queue && queue.textChannel) {
      queue.textChannel.send(`✅ Tzad l queue: \`${song.name}\``).catch(() => {});
    }
  });

  distube.on('finish', (queue) => {
    setTimeout(() => {
      const currentQueue = distube.getQueue(queue.id);
      if (!currentQueue || !currentQueue.playing) {
        try { queue.voice.leave(); } catch (e) {}
      }
    }, 15000);
  });

  distube.on('error', (error, queue, song) => {
    console.error(`[Music] Failed track: ${song?.name || 'unknown'}; source: ${song?.source || 'unknown'}; code: ${error?.errorCode || error?.code || 'unknown'}`);
    console.error('[Music] Playback error:', redactMediaUrls(error?.stack || error?.message || error));
    if (queue && queue.textChannel) {
      const code = error?.errorCode || error?.code || '';
      const userMessage = song?.source === 'soundcloud' && code === 'FFMPEG_EXITED'
        ? '❌ SoundCloud ma9drch yplayi had version (ymken protected aw unavailable). Jreb chi upload/version okhra.'
        : song?.source === 'youtube' && /BOT_CHECK|Sign in to confirm/i.test(`${code} ${error?.message || ''}`)
          ? '❌ YouTube blocka l-bot f Railway f had track. Jreb chi upload/version okhra.'
          : '❌ Ma khdemch l-music daba. Jreb chi track akhor.';
      queue.textChannel.send(userMessage).catch(() => {});
    }
  });
}

// Configuration IDs
const ROLE_ID = process.env.ROLE_ID;
const NOT_VERIFIED_ROLE_ID = process.env.NOT_VERIFIED_ROLE_ID;
const TARGET_VC_ID = process.env.TARGET_VC_ID;
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID;
const MOVE_ROLE_ID = process.env.MOVE_ROLE_ID;
const CATEGORY_ID = process.env.CATEGORY_ID || null;
const CREATE_VC_ID = process.env.CREATE_VC_ID;
const CREATE_CATEGORY_ID = process.env.CREATE_CATEGORY_ID || null;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || null;

// AI Setup: Dynamically fetch REAL Gemini models (Fixes the 503 loop of death)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DEFAULT_GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
// Voice replies use the existing Gemini key and can be tuned or disabled per deployment.
const GEMINI_TTS_MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-lite-tts';
const GEMINI_TTS_VOICE = process.env.GEMINI_TTS_VOICE || 'Kore';
const VOICE_TTS_ENABLED = process.env.VOICE_TTS_ENABLED !== 'false';
const voiceReplyLocks = new Set();
const voiceConversationLocks = new Set();
const voiceListeners = new Map();
const voiceReplyChannels = new Map();
let availableModelsCache = [];
let genAI = null;
if (GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
}

async function fetchSupportedModels() {
  if (!GEMINI_API_KEY) return [];
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      const models = (data.models || [])
        .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
        .map(m => m.name.replace(/^models\//, ''));
      if (models.length > 0) {
        availableModelsCache = models;
        return models;
      }
    }
  } catch (e) {
    console.error(`Could not fetch model list: ${e.message}`);
  }
  return [];
}

function getModelCandidates() {
  // Never wait for model discovery on a user request. Use the configured fast
  // model immediately and keep one discovered Flash model as a 404 fallback.
  const flashModels = availableModelsCache.filter(m =>
    m.toLowerCase().includes('flash') && 
    !m.toLowerCase().includes('tts') && 
    !m.toLowerCase().includes('vision') &&
    !m.toLowerCase().includes('embedding')
  );
  const fallback = flashModels.find(m => m !== DEFAULT_GEMINI_MODEL && m.toLowerCase().includes('flash-lite'))
    || flashModels.find(m => m !== DEFAULT_GEMINI_MODEL);
  return fallback ? [DEFAULT_GEMINI_MODEL, fallback] : [DEFAULT_GEMINI_MODEL];
}

// Warm the model cache during startup without blocking Discord events or replies.
if (GEMINI_API_KEY) fetchSupportedModels().catch(() => {});

function makePcmWav(pcm, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28);
  header.writeUInt16LE(channels * bitsPerSample / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function speakVoiceReply(message, text) {
  if (!VOICE_TTS_ENABLED || !GEMINI_API_KEY || !distube || !message.guild) return false;
  const voiceChannel = message.member?.voice?.channel || message.guild.members.me?.voice?.channel;
  if (!voiceChannel) return false; // Text-only use stays text-only; no unexpected joining.
  if (distube.getQueue(message.guild)) {
    console.log(`[Voice TTS] Skipping reply in ${message.guild.id}: music is playing.`);
    return false;
  }
  if (voiceReplyLocks.has(message.guild.id)) return false;

  let player;
  let connection;
  let idleHandler;
  let errorHandler;
  let spoken = false;
  const guildId = message.guild.id;
  voiceReplyLocks.add(guildId);

  try {
    const { createAudioResource, StreamType,
      AudioPlayerStatus, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
    await distube.voices.join(voiceChannel, { selfDeaf: false });
    const voice = distube.voices.get(guildId);
    connection = voice?.connection;
    if (!connection) throw new Error('Discord voice connection was not available after joining.');
    await entersState(connection, VoiceConnectionStatus.Ready, 8000);
    listenInVoiceChannel(message.guild, connection, message.channel);

    // Keep spoken answers short so they are quick and use fewer TTS tokens.
    const spokenText = text.replace(/<@!?\d+>/g, '').slice(0, 240).trim();
    if (!spokenText) return;
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TTS_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          contents: [{ parts: [{
            // TTS recites the text field verbatim; keep all directions in
            // speechMetadata so it never reads the instructions aloud.
            text: spokenText,
            speechMetadata: { style: 'natural, friendly Moroccan Darija pronunciation, conversational pace' },
          }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { voice: GEMINI_TTS_VOICE } },
          },
        }),
      },
    );
    if (!response.ok) throw new Error(`Gemini TTS returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const data = await response.json();
    const audioPart = data.candidates?.[0]?.content?.parts?.find(part => part.inlineData?.data);
    if (!audioPart) throw new Error('Gemini TTS response did not include audio.');

    const audioBuffer = Buffer.from(audioPart.inlineData.data, 'base64');
    const wavBuffer = audioPart.inlineData.mimeType?.includes('wav')
      ? audioBuffer
      : makePcmWav(audioBuffer);
    // Arbitrary input lets discord.js convert the WAV to Discord's voice
    // format via the FFmpeg installation already used by music playback.
    const resource = createAudioResource(require('node:stream').Readable.from(wavBuffer), {
      inputType: StreamType.Arbitrary,
    });
    // Reuse DisTube's player so speech and music share the same voice
    // connection cleanly instead of replacing its audio subscription.
    player = voice.audioPlayer;
    if (player.state.status !== AudioPlayerStatus.Idle) {
      console.log(`[Voice TTS] Skipping reply in ${guildId}: DisTube player is busy.`);
      return false;
    }

    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        player.off(AudioPlayerStatus.Idle, idleHandler);
        player.off('error', errorHandler);
        err ? reject(err) : resolve();
      };
      idleHandler = () => finish();
      errorHandler = error => finish(error);
      player.once(AudioPlayerStatus.Idle, idleHandler);
      player.once('error', errorHandler);
      player.play(resource);
    });
    spoken = true;
  } catch (error) {
    console.warn(`[Voice TTS] Could not speak reply: ${error.message}`);
  } finally {
    if (player && player.state.status !== 'idle') player.stop(true);
    voiceReplyLocks.delete(guildId);
  }
  return spoken;
}

function listenInVoiceChannel(guild, connection, replyChannel) {
  if (!VOICE_TTS_ENABLED || !GEMINI_API_KEY || !guild || !connection || voiceListeners.has(guild.id)) return;
  const { EndBehaviorType, VoiceConnectionStatus } = require('@discordjs/voice');
  const prism = require('prism-media');
  const listener = { connection, onSpeaking: null, onState: null };
  voiceListeners.set(guild.id, listener);
  if (replyChannel?.isTextBased()) voiceReplyChannels.set(guild.id, replyChannel);

  listener.onSpeaking = (userId) => {
    if (userId === client.user.id || voiceReplyLocks.has(guild.id) || voiceConversationLocks.has(guild.id)) return;
    const member = guild.members.cache.get(userId);
    if (!member || member.user.bot || !member.voice.channelId) return;
    if (distube?.getQueue(guild)) return; // Don't transcribe music or consume API while music is playing.
    voiceConversationLocks.add(guild.id);

    const opusStream = connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 750 },
    });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    const pcmChunks = [];
    let byteCount = 0;
    let captureStopped = false;
    const maxAudioBytes = 48000 * 2 * 2 * 12; // 12 seconds, 48 kHz stereo signed 16-bit PCM.
    const stopCapture = () => {
      if (captureStopped) return;
      captureStopped = true;
      opusStream.unpipe(decoder);
      decoder.end();
      opusStream.destroy();
    };
    const captureTimeout = setTimeout(stopCapture, 12000);
    opusStream.pipe(decoder);
    decoder.on('data', chunk => {
      byteCount += chunk.length;
      if (byteCount <= maxAudioBytes) pcmChunks.push(chunk);
      else stopCapture();
    });
    decoder.once('error', error => {
      clearTimeout(captureTimeout);
      console.warn(`[Voice Listen] Decode error: ${error.message}`);
      voiceConversationLocks.delete(guild.id);
    });
    decoder.once('end', () => {
      clearTimeout(captureTimeout);
      const pcm = Buffer.concat(pcmChunks);
      if (pcm.length < 48000 * 2 * 2 * 0.35) {
        voiceConversationLocks.delete(guild.id);
        return;
      }
      answerVoiceUtterance(guild, member, pcm).catch(error => {
        console.warn(`[Voice Listen] Could not answer: ${error.message}`);
        const textChannel = voiceReplyChannels.get(guild.id);
        if (textChannel?.isTextBased()) {
          textChannel.send('Sme7 lia, ma qdertch nfhem l-hdra. T2ekked men API key w credits dyal bot.').catch(() => {});
        }
      }).finally(() => voiceConversationLocks.delete(guild.id));
    });
    opusStream.once('error', error => {
      clearTimeout(captureTimeout);
      console.warn(`[Voice Listen] Capture error: ${error.message}`);
      voiceConversationLocks.delete(guild.id);
    });
  };

  listener.onState = (_oldState, newState) => {
    if (newState.status !== VoiceConnectionStatus.Destroyed) return;
    connection.receiver.speaking.off('start', listener.onSpeaking);
    connection.off('stateChange', listener.onState);
    voiceListeners.delete(guild.id);
    voiceReplyChannels.delete(guild.id);
  };
  connection.receiver.speaking.on('start', listener.onSpeaking);
  connection.on('stateChange', listener.onState);
  console.log(`[Voice Listen] Listening for speech in ${guild.id}.`);
}

async function answerVoiceUtterance(guild, member, pcm) {
  const model = getModelCandidates()[0];
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        contents: [{ parts: [
          { text: `You are Kho Kokiee in a Discord voice channel. First decide whether the speaker is directly calling you by saying "Kho Kokiee", "Kokiee", or "hey bot". If they did not clearly call you by one of those names, output exactly [IGNORE] and nothing else. Do not answer ordinary conversation or speech addressed to another person. If they did call you, answer what they said in one short, natural sentence of Moroccan Darija written with Latin letters (Arabizi), like "salam cv". Do not transcribe their speech. The speaker is ${member.displayName}.` },
          { inlineData: { mimeType: 'audio/wav', data: makePcmWav(pcm, 48000, 2).toString('base64') } },
        ] }],
        generationConfig: { maxOutputTokens: 90, temperature: 0.6 },
      }),
    },
  );
  if (!response.ok) throw new Error(`Gemini audio returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const data = await response.json();
  const answer = (data.candidates?.[0]?.content?.parts || [])
    .map(part => part.text || '')
    .join(' ')
    .trim()
    .slice(0, 240);
  if (!answer) throw new Error('Gemini returned no answer for the voice message.');
  if (answer.toUpperCase().startsWith('[IGNORE]')) {
    console.log(`[Voice Listen] Ignored speech not addressed to the bot in ${guild.id}.`);
    return;
  }

  const textChannel = voiceReplyChannels.get(guild.id);
  if (textChannel?.isTextBased()) {
    await textChannel.send({ content: `${member}, ${answer}`, allowedMentions: { parse: [], users: [member.id] } }).catch(() => {});
  }
  // Playback can succeed even when DisTube changes player state before the
  // completion check settles. Keep failures in logs instead of sending a
  // misleading text warning after the audible answer.
  await speakVoiceReply({ guild, member, channel: textChannel }, answer);
}

const aiUserCooldowns = new Map();
const AI_COOLDOWN_MS = 2000;
const AI_MAX_QUESTION_CHARS = 1500;
const AI_MAX_CONTEXT_CHARS = 1200;
const AI_MAX_OUTPUT_TOKENS = 120;
const roomOwners = new Map();
const userAddressForms = new Map();

async function sendLog(guild, messageText) {
  if (!LOG_CHANNEL_ID) return;
  try {
    const logChannel = guild.channels.cache.get(LOG_CHANNEL_ID) || await guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (logChannel && logChannel.isTextBased()) await logChannel.send(messageText);
  } catch (error) {}
}

async function startVerification(guild, member) {
  if (!STAFF_ROLE_ID) return { success: false, error: 'STAFF_ROLE_ID is not configured.' };
  try {
    const overwrites = [
      { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
      { id: member.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak] },
      { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels] },
    ];

    const staffRole = guild.roles.cache.get(STAFF_ROLE_ID);
    if (staffRole) overwrites.push({ id: staffRole.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak, PermissionsBitField.Flags.SendMessages] });

    const newChannel = await guild.channels.create({
      name: `verify-${member.displayName}`,
      type: ChannelType.GuildVoice,
      parent: (CATEGORY_ID && CATEGORY_ID.length > 5) ? CATEGORY_ID : null,
      permissionOverwrites: overwrites,
    });

    if (member.voice && member.voice.channelId) await member.voice.setChannel(newChannel).catch(() => {});
    newChannel.send(`👋 Salam <@${member.id}>! Daba ghadi yjiw staff bach yverify-iwk. Stenna chwia hna 🙂`).catch(() => {});
    newChannel.send(`<@&${STAFF_ROLE_ID}> New verification session for **${member.displayName}**. Please come verify them here!`).catch(() => {});
    member.send(`👋 Salam ${member.displayName}! 3ayetna l staff bach yverify-iwk. Dkhol l <#${newChannel.id}> daba 🙂`).catch(() => {});
    sendLog(guild, `🛡️ **Verification Session:** <@${member.id}> started a verification session in \`${newChannel.name}\`.`).catch(() => {});
    return { success: true, user: member.displayName, mention: `<@${member.id}>`, channel: newChannel.name };
  } catch (err) {
    return { success: false, error: `Failed to start verification: ${err.message}` };
  }
}

async function createPersonalVoiceRoom(guild, member) {
  const safeName = (member.displayName || member.user.username).replace(/[\r\n]/g, ' ').slice(0, 75);
  const overwrites = [
    { id: member.id, allow: [PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak, PermissionsBitField.Flags.SendMessages] },
    { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak, PermissionsBitField.Flags.ManageChannels] },
  ];
  if (NOT_VERIFIED_ROLE_ID) overwrites.push({ id: NOT_VERIFIED_ROLE_ID, deny: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect] });

  const channel = await guild.channels.create({
    name: `🔊 ${safeName}'s Room`,
    type: ChannelType.GuildVoice,
    parent: (CREATE_CATEGORY_ID && CREATE_CATEGORY_ID.length > 5) ? CREATE_CATEGORY_ID : null,
    permissionOverwrites: overwrites,
  });
  roomOwners.set(channel.id, member.id);
  try {
    await member.voice.setChannel(channel);
  } catch (error) {
    roomOwners.delete(channel.id);
    await channel.delete().catch(() => {});
    throw error;
  }
  sendLog(guild, `🎙️ **Room Created:** <@${member.id}> created a custom voice channel (\`${channel.name}\`).`).catch(() => {});
  return channel;
}

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}! Bot is online and ready.`);
  if (!GEMINI_API_KEY) console.log('⚠️ GEMINI_API_KEY is missing. AI replies disabled.');
  else console.log(`🤖 Gemini AI ready.`);
});

// Guild Events (Roles, Nicknames, Voice States)
client.on('guildMemberAdd', async (member) => {
  try {
    const role = member.guild.roles.cache.get(ROLE_ID);
    if (!role) return;
    await member.roles.add(role);
    sendLog(member.guild, `📥 **New Member:** Assigned the base role to <@${member.id}>.`).catch(() => {});
  } catch (error) {}
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  if (oldMember.nickname !== newMember.nickname) {
    const oldName = oldMember.nickname || oldMember.user.username;
    const newName = newMember.nickname || newMember.user.username;
    let executorString = `<@${newMember.id}> (Self-changed)`;
    try {
      const fetchedLogs = await newMember.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.MemberUpdate });
      const updateLog = fetchedLogs.entries.first();
      if (updateLog && updateLog.target.id === newMember.id && (Date.now() - updateLog.createdTimestamp < 3000)) executorString = `<@${updateLog.executor.id}>`;
    } catch (e) {}
    sendLog(newMember.guild, `📝 **Nickname Change:** ${executorString} changed the nickname of <@${newMember.id}> from \`${oldName}\` to \`${newName}\`.`).catch(() => {});
  }
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
    let executorString = `<@${newState.member.id}> (Self-moved)`;
    try {
      const fetchedLogs = await newState.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.MemberMove });
      const moveLog = fetchedLogs.entries.first();
      if (moveLog && moveLog.target.id === newState.member.id && (Date.now() - moveLog.createdTimestamp < 3000)) executorString = `<@${moveLog.executor.id}> (Moderator)`;
    } catch (err) {}
    sendLog(newState.guild, `🔀 **Voice Move:** ${executorString} moved <@${newState.member.id}> from \`${oldState.channel.name}\` to \`${newState.channel.name}\`.`).catch(() => {});
  }

  if (oldState.serverMute !== newState.serverMute || oldState.serverDeaf !== newState.serverDeaf) {
    let action = '';
    if (!oldState.serverMute && newState.serverMute) action = 'server muted';
    else if (oldState.serverMute && !newState.serverMute) action = 'server unmuted';
    else if (!oldState.serverDeaf && newState.serverDeaf) action = 'server deafened';
    else if (oldState.serverDeaf && !newState.serverDeaf) action = 'server undeafened';

    if (action) {
      let executorString = 'A moderator';
      try {
        const fetchedLogs = await newState.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.MemberUpdate });
        const updateLog = fetchedLogs.entries.first();
        if (updateLog && updateLog.target.id === newState.member.id && (Date.now() - updateLog.createdTimestamp < 3000)) executorString = `<@${updateLog.executor.id}>`;
      } catch (err) {}
      sendLog(newState.guild, `🔇 **Voice Moderation:** ${executorString} ${action} <@${newState.member.id}>.`).catch(() => {});
    }
  }

  if (oldState.channel) {
    const channel = oldState.channel;
    if ((channel.name.startsWith('verify-') || roomOwners.has(channel.id) || channel.name.startsWith('🔊 ')) && channel.members.size === 0) {
      try {
        roomOwners.delete(channel.id);
        await channel.delete();
        sendLog(channel.guild, `🗑️ **Room Deleted:** Auto-deleted empty channel \`${channel.name}\`.`).catch(() => {});
      } catch (err) {}
    }
  }

  if (CREATE_VC_ID && newState.channelId === CREATE_VC_ID && oldState.channelId !== CREATE_VC_ID) {
    const member = newState.member;
    try {
      const customChannel = await createPersonalVoiceRoom(newState.guild, member);
      setTimeout(() => {
        customChannel.send(`👋 Welcome to your room, <@${member.id}>!\nUse \`.a name <new name>\`, \`.a lock\`, \`.a unlock\`, \`.a limit <number>\`, \`.a add @User\`, \`.a reject @User\``).catch(() => {});
      }, 1000);
    } catch (error) {}
  }

  if (TARGET_VC_ID && newState.channelId === TARGET_VC_ID && oldState.channelId !== TARGET_VC_ID) {
    if (NOT_VERIFIED_ROLE_ID && !newState.member.roles.cache.has(NOT_VERIFIED_ROLE_ID)) return;
    await startVerification(newState.guild, newState.member);
  }
});

// ==========================================
// AI MODERATION & VOICE TOOLS DEFINITION
// ==========================================
const discordTools = [{
  functionDeclarations: [
    { name: 'give_role', description: 'Assigns a Discord role to a user.', parameters: { type: 'OBJECT', properties: { target_user: { type: 'STRING' }, role_name: { type: 'STRING' } }, required: ['target_user', 'role_name'] } },
    { name: 'remove_role', description: 'Removes a Discord role from a user.', parameters: { type: 'OBJECT', properties: { target_user: { type: 'STRING' }, role_name: { type: 'STRING' } }, required: ['target_user', 'role_name'] } },
    { name: 'mute_member', description: 'Voice mutes a user.', parameters: { type: 'OBJECT', properties: { target_user: { type: 'STRING' } }, required: ['target_user'] } },
    { name: 'unmute_member', description: 'Voice unmutes a user.', parameters: { type: 'OBJECT', properties: { target_user: { type: 'STRING' } }, required: ['target_user'] } },
    { name: 'move_member', description: 'Moves a user to your voice channel.', parameters: { type: 'OBJECT', properties: { target_user: { type: 'STRING' }, destination: { type: 'STRING' } }, required: ['target_user'] } },
    { name: 'disconnect_member', description: 'Kicks user from voice.', parameters: { type: 'OBJECT', properties: { target_user: { type: 'STRING' } }, required: ['target_user'] } },
    { name: 'deafen_member', description: 'Server deafens a user.', parameters: { type: 'OBJECT', properties: { target_user: { type: 'STRING' } }, required: ['target_user'] } },
    { name: 'undeafen_member', description: 'Undeafens a user.', parameters: { type: 'OBJECT', properties: { target_user: { type: 'STRING' } }, required: ['target_user'] } },
    { name: 'create_channel', description: 'Creates a channel.', parameters: { type: 'OBJECT', properties: { name: { type: 'STRING' }, type: { type: 'STRING' } }, required: ['name'] } },
    { name: 'manage_current_channel', description: 'Locks or opens the current text channel, or the caller-owned temporary voice room. Use scope text for chat channels and voice for a voice room. Only act when the user clearly asks to lock/close or open/unlock it.', parameters: { type: 'OBJECT', properties: { action: { type: 'STRING', enum: ['lock', 'unlock'] }, scope: { type: 'STRING', enum: ['text', 'voice'] } }, required: ['action', 'scope'] } },
    { name: 'rename_voice_room', description: 'Renames the caller-owned temporary voice room to the requested name.', parameters: { type: 'OBJECT', properties: { name: { type: 'STRING' } }, required: ['name'] } },
    { name: 'reject_voice_member', description: 'Rejects a member from the caller-owned temporary voice room by denying Connect and disconnecting them. Requires target_user.', parameters: { type: 'OBJECT', properties: { target_user: { type: 'STRING' } }, required: ['target_user'] } },
    { name: 'create_personal_voice_room', description: 'Creates a new personal temporary voice room for the person asking and moves them into it. Use when they ask for a new voice room/channel for themselves.', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'create_role', description: 'Creates a role.', parameters: { type: 'OBJECT', properties: { name: { type: 'STRING' } }, required: ['name'] } },
    { name: 'move_all_members', description: 'Moves everyone from the named source voice channel to the named destination voice channel (or the caller voice channel when destination is "here").', parameters: { type: 'OBJECT', properties: { source_channel: { type: 'STRING' }, destination_channel: { type: 'STRING' } }, required: ['source_channel', 'destination_channel'] } },
    { name: 'move_members', description: 'Moves specific multiple users.', parameters: { type: 'OBJECT', properties: { target_users: { type: 'STRING' }, destination: { type: 'STRING' } }, required: ['target_users'] } },
    { name: 'dm_members', description: 'DMs users.', parameters: { type: 'OBJECT', properties: { target_users: { type: 'STRING' }, message_text: { type: 'STRING' } }, required: ['target_users', 'message_text'] } },
    { name: 'start_verification', description: 'Starts verification.', parameters: { type: 'OBJECT', properties: { target_user: { type: 'STRING' } } } },
    { name: 'join_voice', description: 'Joins voice channel.', parameters: { type: 'OBJECT', properties: { channel: { type: 'STRING' } } } },
    { name: 'play_music', description: 'Plays a song.', parameters: { type: 'OBJECT', properties: { query: { type: 'STRING' } }, required: ['query'] } },
    { name: 'skip_music', description: 'Skips the song.', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'stop_music', description: 'Stops music.', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'leave_music', description: 'Leaves voice.', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'delete_channel', description: 'Deletes channel.', parameters: { type: 'OBJECT', properties: { channel_name: { type: 'STRING' } }, required: ['channel_name'] } },
    { name: 'delete_role', description: 'Deletes role.', parameters: { type: 'OBJECT', properties: { role_name: { type: 'STRING' } }, required: ['role_name'] } },
  ]
}];

function findRole(guild, roleQuery) {
  if (!roleQuery) return null;
  const clean = roleQuery.replace(/^[<@&>#\s]+/, '').replace(/[>\s]+$/, '').trim().toLowerCase();
  if (/^\d{17,20}$/.test(clean)) { const role = guild.roles.cache.get(clean); if (role) return role; }
  return guild.roles.cache.find(r => r.name.toLowerCase() === clean) || guild.roles.cache.find(r => r.name.toLowerCase().includes(clean)) || null;
}

function findChannel(guild, query, type) {
  if (!query) return null;
  const clean = query.replace(/^[<#>#\s]+/, '').replace(/[>\s]+$/, '').trim().toLowerCase();
  if (/^\d{17,20}$/.test(clean)) { const ch = guild.channels.cache.get(clean); if (ch) return ch; }
  const filterType = (ch) => {
    if (type === 'category' && ch.type !== ChannelType.GuildCategory) return false;
    if (type === 'voice' && !ch.isVoiceBased()) return false;
    if (type === 'text' && !ch.isTextBased()) return false;
    return true;
  };
  return guild.channels.cache.find(ch => filterType(ch) && ch.name.toLowerCase() === clean) || guild.channels.cache.find(ch => filterType(ch) && ch.name.toLowerCase().includes(clean)) || null;
}

function findVoiceChannel(guild, query) {
  return findChannel(guild, query, 'voice');
}

async function findTargetMember(guild, query, mentions, botId) {
  if (mentions && mentions.members && mentions.members.size > 0) {
    const target = mentions.members.find(m => m.id !== botId);
    if (target) return target;
  }
  if (!query) return null;
  const idMatch = query.match(/\d{17,20}/);
  if (idMatch) {
    const cachedById = guild.members.cache.get(idMatch[0]);
    if (cachedById) return cachedById;
    try { const byId = await guild.members.fetch(idMatch[0]); if (byId) return byId; } catch (e) {}
  }
  const cleanName = query.replace(/^[@🔊\s]+/, '').toLowerCase().trim();
  if (!cleanName) return null;
  const cachedMember = guild.members.cache.find(m => m.user.username.toLowerCase().includes(cleanName) || m.displayName.toLowerCase().includes(cleanName));
  if (cachedMember) return cachedMember;
  try { const searched = await guild.members.fetch({ query: cleanName, limit: 5 }); if (searched && searched.size > 0) return searched.first(); } catch (e) {}
  return null;
}

async function resolveMembers(guild, targetUsers, mentions, botId) {
  const found = new Map();
  if (mentions && mentions.members && mentions.members.size > 0) {
    for (const m of mentions.members.values()) { if (m.id !== botId) found.set(m.id, m); }
  }
  if (targetUsers) {
    const parts = String(targetUsers).split(/[,\u060C\n]+/).map(s => s.trim()).filter(Boolean);
    for (const part of parts) { const m = await findTargetMember(guild, part, null, botId); if (m) found.set(m.id, m); }
  }
  return Array.from(found.values());
}

function extractResponseText(response) {
  if (!response) return '';
  try { const text = response.text(); if (text && text.trim()) return text.trim(); } catch (e) {}
  const parts = response?.candidates?.[0]?.content?.parts || [];
  const nonThought = parts.filter(p => !p.thought && p.text);
  if (nonThought.length > 0) return nonThought.map(p => p.text).join('\n').trim();
  return parts.map(p => p.text).filter(Boolean).join('\n').trim();
}

function formatToolSummary(executedTools) {
  return executedTools
    .map(({ name, result: r }) => {
      if (!r || r.success === false) return `Ma qdertch ndir **${name}**: ${r?.error || 'unknown error'}`;
      switch (name) {
        case 'give_role': return `Safi a khay, 3tit role **${r.role}** l ${r.mention || r.user} ✅`;
        case 'remove_role': return `Safi 7eyedt role **${r.role}** mn ${r.mention || r.user} ✅`;
        case 'mute_member': return `Safi a khay, sket ${r.mention || r.user} f l-voice 👍`;
        case 'unmute_member': return `Safi telqt ${r.mention || r.user} 👍`;
        case 'move_member': return `Hani jbedt ${r.mention || r.user} l ${r.channel} 😉`;
        case 'disconnect_member': return `Safi kherrejt ${r.mention || r.user} mn l voice 🚪`;
        case 'deafen_member': return `Safi sdemt ${r.mention || r.user} f voice 🔇`;
        case 'undeafen_member': return `Safi 7eyedt sdem l ${r.mention || r.user} 🔊`;
        case 'move_all_members': return `Safi 7rekkt **${r.moved}** members mn \`${r.source}\` l \`${r.dest}\` 🧲`;
        case 'create_channel': return `Safi creatit ${r.type === 'voice' ? 'voice' : 'text'} channel ${r.mention || r.name} ✅`;
        case 'create_role': return `Safi creatit role ${r.mention || r.name} ✅`;
        case 'move_members': return `Safi jbedt **${r.moved}** members l \`${r.dest}\` 🧲`;
        case 'dm_members': return `Safi sift message f privé l **${r.sent}** members 📩`;
        case 'start_verification': return `Safi bda l-verify, staff ghadi yjiw l ${r.mention || r.user} ✅`;
        case 'join_voice': return `Safi dkhalt l voice \`${r.channel}\` 🔊`;
        case 'play_music': return `Kan9elleb 3la \`${r.query}\` daba 🎶`;
        case 'manage_current_channel': return r.scope === 'voice'
          ? `Safi ${r.action === 'lock' ? 'seddt' : '7ellit'} voice room \`${r.channel}\` ${r.action === 'lock' ? '🔒' : '🔓'}`
          : `Safi ${r.action === 'lock' ? 'seddt' : '7ellit'} text channel <#${r.channelId || ''}> ${r.action === 'lock' ? '🔒' : '🔓'}`;
        case 'rename_voice_room': return `Safi bdeltt smit room l ${r.name} ✅`;
        case 'reject_voice_member': return `Safi khrejt ${r.mention || r.user} mn ${r.channel} w ma bqach y9der ydkhol 🔒`;
        case 'create_personal_voice_room': return `Safi swebt lik room jdida ${r.mention} w 7rektek liha 🔊`;
        case 'skip_music': return `Safi skipt l-ghnya ⏭️`;
        case 'stop_music': return `Safi w9eft l-music ⏹️`;
        case 'leave_music': return `Safi kherrejt mn l voice 👋`;
        case 'delete_channel': return `Safi ms7t channel \`${r.name}\` 🗑️`;
        case 'delete_role': return `Safi ms7t role \`${r.name}\` 🗑️`;
        default: return `Safi t-dar l-action **${name}** ✅`;
      }
    }).join('\n');
}

function getDirectChannelIntent(text, message) {
  const input = text.toLowerCase().trim();
  if (/^(how do i|how can i|how to|kifach|chno ma3na|what is)\b/.test(input)) return null;
  if (/\bmazakni\b/i.test(input)) {
    return { name: 'play_music', args: { query: 'mazakni' } };
  }
  const callerRoom = message.member?.voice?.channel;
  const ownsCurrentRoom = callerRoom && isVoiceRoomOwner(message.member, callerRoom);
  const isInTemporaryRoom = callerRoom && (roomOwners.has(callerRoom.id) || callerRoom.name.startsWith('🔊 '));
  const hasVoiceScope = /\b(voice|room)\b/.test(input) || (isInTemporaryRoom && /\btap\b/.test(input));
  const hasTextScope = /\b(text|chat|text channel)\b/.test(input);
  if (/\b(create|make|new|sweb|dir)\b/.test(input) && /\b(voice|room)\b/.test(input)) {
    return { name: 'create_personal_voice_room', args: {} };
  }
  const lock = /\b(lock|close|ssed|sedd|sdd|7bes)\b/.test(input);
  const unlock = /\b(open|unlock|t?7ol|t?7ell|t?7el|t?7oul)\b/.test(input);
  if ((lock || unlock) && /\b(tap|chat|channel|voice|room)\b/.test(input)) {
    return { name: 'manage_current_channel', args: { action: lock ? 'lock' : 'unlock', scope: hasVoiceScope && !hasTextScope ? 'voice' : 'text' } };
  }

  if (/\b(rename|bdel|bddel|change name|change the name)\b/.test(input)
    && (/\b(room|voice|smit|smiya)\b/.test(input) || ownsCurrentRoom)) {
    const patterns = [
      /\brename\s+(?:my\s+)?(?:voice\s+)?room\s+(?:to\s+)?(.+)$/i,
      /\bchange\s+(?:the\s+)?name\s+(?:of\s+(?:my\s+)?(?:voice\s+)?room\s+)?(?:to\s+)?(.+)$/i,
      /\bb(?:d|dd)el\s+(?:smit|smiya)\s+(?:l-?)?(?:room|voice)?\s*(?:l|to|:)?\s*(.+)$/i,
    ];
    const match = patterns.map(pattern => input.match(pattern)).find(Boolean);
    if (match?.[1]?.trim()) return { name: 'rename_voice_room', args: { name: match[1].trim().replace(/["'`]/g, '') } };
  }

  if (/\b(reject|kick|remove|tred|tayr|khrrej)\b/.test(input)) {
    const target = message.mentions.members.find(member => member.id !== client.user.id);
    if (!target && !/\b(room|voice|member|user|person)\b/.test(input)) return null;
    if (target) return { name: 'reject_voice_member', args: { target_user: target.id } };
    return { name: 'reject_voice_member', args: {} };
  }
  return null;
}

function explicitlyRequestedVoiceModeration(message, action) {
  const text = message.content
    .replace(new RegExp(`<@!?${message.client.user.id}>`, 'g'), '')
    .toLowerCase();
  if (action === 'mute') return /\b(mute|silence|sket|saket|skt)\b/.test(text);
  if (action === 'unmute') return /\b(unmute|unsilence|tl9|tlaq|7ell l-mic)\b/.test(text);
  return false;
}

function getAddressFormPreference(text) {
  const input = text.toLowerCase().trim();
  const feminine = /\b(?:i am|i'm|im|call me|use|talk to me (?:as|using)|address me as)\s+(?:a\s+)?(?:girl|woman|female|nti)\b/.test(input)
    || /\b(?:ana bent|ana mra|3ayet liya b nti|hdar m3aya b nti|khatebni b nti)\b/.test(input);
  const masculine = /\b(?:i am|i'm|im|call me|use|talk to me (?:as|using)|address me as)\s+(?:a\s+)?(?:boy|man|male|nta)\b/.test(input)
    || /\b(?:ana weld|ana rajel|3ayet liya b nta|hdar m3aya b nta|khatebni b nta)\b/.test(input);
  if (feminine === masculine) return null;
  return feminine ? 'feminine' : 'masculine';
}

function checkRoleManagementPermissions(caller, role, guild) {
  const isOwner = guild.ownerId === caller.id;
  const isAdmin = caller.permissions.has(PermissionsBitField.Flags.Administrator);
  const canManageRoles = caller.permissions.has(PermissionsBitField.Flags.ManageRoles);
  const hasStaffRole = STAFF_ROLE_ID && caller.roles.cache.has(STAFF_ROLE_ID);
  if (!isOwner && !isAdmin && !canManageRoles && !hasStaffRole) return { allowed: false, error: `Permission denied.` };
  const botMember = guild.members.me;
  if (role.position >= botMember.roles.highest.position) return { allowed: false, error: `Role higher than bot.` };
  if (!isOwner && role.position >= caller.roles.highest.position) return { allowed: false, error: `Role higher than yours.` };
  if (role.managed) return { allowed: false, error: `Role managed by integration.` };
  return { allowed: true };
}

function canCallerModerate(caller) {
  return (STAFF_ROLE_ID && caller.roles.cache.has(STAFF_ROLE_ID)) || caller.permissions.has(PermissionsBitField.Flags.Administrator) || caller.permissions.has(PermissionsBitField.Flags.MuteMembers);
}

function canCallerMove(caller) {
  return (MOVE_ROLE_ID && caller.roles.cache.has(MOVE_ROLE_ID)) || (STAFF_ROLE_ID && caller.roles.cache.has(STAFF_ROLE_ID)) || caller.permissions.has(PermissionsBitField.Flags.Administrator) || caller.permissions.has(PermissionsBitField.Flags.MoveMembers);
}

function canManageChannels(caller) {
  return (STAFF_ROLE_ID && caller.roles.cache.has(STAFF_ROLE_ID)) || caller.permissions.has(PermissionsBitField.Flags.Administrator) || caller.permissions.has(PermissionsBitField.Flags.ManageChannels);
}

function isVoiceRoomOwner(caller, channel) {
  return roomOwners.get(channel.id) === caller.id
    || (channel.name.startsWith('🔊 ') && channel.permissionOverwrites.cache.get(caller.id)?.allow.has(PermissionsBitField.Flags.ManageChannels));
}

function canManageRoles(caller) {
  return (STAFF_ROLE_ID && caller.roles.cache.has(STAFF_ROLE_ID)) || caller.permissions.has(PermissionsBitField.Flags.Administrator) || caller.permissions.has(PermissionsBitField.Flags.ManageRoles);
}

async function executeDiscordTool(name, args, message) {
  const caller = message.member;
  const noTargetTools = ['create_channel', 'manage_current_channel', 'rename_voice_room', 'create_personal_voice_room', 'create_role', 'move_all_members', 'move_members', 'dm_members', 'start_verification', 'join_voice', 'play_music', 'skip_music', 'stop_music', 'leave_music', 'delete_channel', 'delete_role'];

  let targetMember = null;
  if (!noTargetTools.includes(name)) {
    targetMember = await findTargetMember(message.guild, args.target_user, message.mentions, message.client.user.id);
    if (!targetMember) return { success: false, error: `Ma lqitch chi member b smit "${args.target_user}".` };
  }

  if (name === 'give_role') {
    const role = findRole(message.guild, args.role_name);
    if (!role) return { success: false, error: `Role "${args.role_name}" ma kaynch.` };
    const check = checkRoleManagementPermissions(caller, role, message.guild);
    if (!check.allowed) return { success: false, error: check.error };
    try { await targetMember.roles.add(role); return { success: true, user: targetMember.displayName, mention: `<@${targetMember.id}>`, role: role.name }; } catch (err) { return { success: false, error: err.message }; }
  }

  if (name === 'remove_role') {
    const role = findRole(message.guild, args.role_name);
    if (!role) return { success: false, error: `Role "${args.role_name}" ma kaynch.` };
    if (ROLE_ID && role.id === ROLE_ID) return { success: false, error: 'Ma ymkench t-7eyed role l-asasi.' };
    const check = checkRoleManagementPermissions(caller, role, message.guild);
    if (!check.allowed) return { success: false, error: check.error };
    try { await targetMember.roles.remove(role); return { success: true, user: targetMember.displayName, mention: `<@${targetMember.id}>`, role: role.name }; } catch (err) { return { success: false, error: err.message }; }
  }

  if (name === 'mute_member') {
    if (!explicitlyRequestedVoiceModeration(message, 'mute')) return { success: false, error: 'Ma n9drch n-muti chi wa7ed bla ma tlebha nta b wadou7.' };
    if (!canCallerModerate(caller)) return { success: false, error: 'Ghir staff.' };
    if (targetMember.id === message.client.user.id) return { success: false, error: 'Ma ymkench t-muti l-bot.' };
    if (!targetMember.voice.channel) return { success: false, error: `${targetMember.displayName} ma dakhltch l voice.` };
    try { await targetMember.voice.setMute(true); return { success: true, user: targetMember.displayName, mention: `<@${targetMember.id}>` }; } catch (err) { return { success: false, error: err.message }; }
  }

  if (name === 'unmute_member') {
    if (!explicitlyRequestedVoiceModeration(message, 'unmute')) return { success: false, error: 'Ma n9drch n-unmute chi wa7ed bla ma tlebha nta b wadou7.' };
    if (!canCallerModerate(caller)) return { success: false, error: 'Ghir staff.' };
    try { if (targetMember.voice.channel) await targetMember.voice.setMute(false); return { success: true, user: targetMember.displayName, mention: `<@${targetMember.id}>` }; } catch (err) { return { success: false, error: err.message }; }
  }

  if (name === 'move_member') {
    if (!canCallerMove(caller)) return { success: false, error: 'Ma 3ndekch permission.' };
    if (!targetMember.voice.channel) return { success: false, error: `${targetMember.displayName} ma dakhltch l voice.` };
    let dest = caller.voice.channel;
    if (args.destination && !['me', 'here', 'hna'].includes(args.destination.toLowerCase())) dest = findVoiceChannel(message.guild, args.destination) || dest;
    if (!dest) return { success: false, error: 'Khassek tkon f voice channel.' };
    try { await targetMember.voice.setChannel(dest); return { success: true, user: targetMember.displayName, channel: dest.name, mention: `<@${targetMember.id}>` }; } catch (err) { return { success: false, error: err.message }; }
  }

  if (name === 'disconnect_member') {
    if (!canCallerMove(caller)) return { success: false, error: 'Ma 3ndekch permission.' };
    if (!targetMember.voice.channel) return { success: false, error: `${targetMember.displayName} ma dakhltch l voice.` };
    try { await targetMember.voice.disconnect(); return { success: true, user: targetMember.displayName, mention: `<@${targetMember.id}>` }; } catch (err) { return { success: false, error: err.message }; }
  }

  if (name === 'deafen_member') {
    if (!canCallerModerate(caller) && !caller.permissions.has(PermissionsBitField.Flags.DeafenMembers)) return { success: false, error: 'Ma 3ndekch permission.' };
    try { await targetMember.voice.setDeaf(true); return { success: true, user: targetMember.displayName, mention: `<@${targetMember.id}>` }; } catch (err) { return { success: false, error: err.message }; }
  }

  if (name === 'undeafen_member') {
    if (!canCallerModerate(caller) && !caller.permissions.has(PermissionsBitField.Flags.DeafenMembers)) return { success: false, error: 'Ma 3ndekch permission.' };
    try { await targetMember.voice.setDeaf(false); return { success: true, user: targetMember.displayName, mention: `<@${targetMember.id}>` }; } catch (err) { return { success: false, error: err.message }; }
  }

  if (name === 'manage_current_channel') {
    const action = String(args.action || '').toLowerCase();
    const scope = String(args.scope || 'text').toLowerCase();
    if (!['lock', 'unlock'].includes(action)) return { success: false, error: 'Khas action ykon lock ola unlock.' };

    if (scope === 'voice') {
      const voiceChannel = caller.voice.channel;
      if (!voiceChannel) return { success: false, error: 'Dkhol l voice room li bghiti t7kem fih.' };
      if (!isVoiceRoomOwner(caller, voiceChannel)) return { success: false, error: 'Ghir moul had voice room y9der ylockiha aw y7ellha.' };
      try {
        await voiceChannel.permissionOverwrites.edit(message.guild.id, { Connect: action === 'lock' ? false : null });
        return { success: true, action, scope: 'voice', channel: voiceChannel.name };
      } catch (err) { return { success: false, error: err.message }; }
    }

    if (!canManageChannels(caller)) return { success: false, error: 'Khassek permission dyal Manage Channels bach t7kem f text channel.' };
    const textChannel = message.channel;
    if (!textChannel.permissionOverwrites) return { success: false, error: 'Ma n9drch nlocki had no3 dyal channel.' };
    let everyoneUpdated = false;
    try {
      await textChannel.permissionOverwrites.edit(message.guild.id, { SendMessages: action === 'lock' ? false : null });
      everyoneUpdated = true;
      if (action === 'lock') {
        await textChannel.permissionOverwrites.edit(client.user.id, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
        });
      }
      return { success: true, action, scope: 'text', channel: textChannel.name, channelId: textChannel.id };
    } catch (err) {
      if (action === 'lock' && everyoneUpdated) await textChannel.permissionOverwrites.edit(message.guild.id, { SendMessages: null }).catch(() => {});
      return { success: false, error: err.message };
    }
  }

  if (name === 'create_personal_voice_room') {
    if (!caller.voice.channel) return { success: false, error: 'Dkhol l chi voice channel lwl, bach n9der ndir lik room w n7rekek lih.' };
    try {
      const channel = await createPersonalVoiceRoom(message.guild, caller);
      return { success: true, name: channel.name, mention: `<#${channel.id}>`, user: caller.displayName };
    } catch (err) { return { success: false, error: err.message }; }
  }

  if (name === 'rename_voice_room') {
    const voiceChannel = caller.voice.channel;
    if (!voiceChannel) return { success: false, error: 'Dkhol l voice room dyalk lwl.' };
    if (!isVoiceRoomOwner(caller, voiceChannel) && !canManageChannels(caller)) return { success: false, error: 'T9der tbdel smit ghir room dyalk, aw khassek permission dyal staff.' };
    const requestedName = String(args.name || '').replace(/[\r\n]/g, ' ').replace(/^🔊\s*/, '').trim();
    if (!requestedName) return { success: false, error: '3tini smiya jdida dyal room.' };
    try {
      const name = `🔊 ${requestedName}`.slice(0, 100);
      await voiceChannel.setName(name);
      return { success: true, name: voiceChannel.name };
    } catch (err) { return { success: false, error: err.message }; }
  }

  if (name === 'reject_voice_member') {
    const voiceChannel = caller.voice.channel;
    if (!voiceChannel) return { success: false, error: 'Dkhol l voice room dyalk lwl.' };
    if (!isVoiceRoomOwner(caller, voiceChannel) && !canManageChannels(caller)) return { success: false, error: 'T9der t-rejecti ghir f room dyalk, aw khassek permission dyal staff.' };
    if (!targetMember) return { success: false, error: 'Mentionni l-member li bghiti t-rejecti.' };
    if (targetMember.id === caller.id) return { success: false, error: 'Ma t9drch t-rejecti rassek 😅' };
    if (targetMember.voice.channelId !== voiceChannel.id) return { success: false, error: 'Had member ma kaynach f room dyalk.' };
    try {
      await voiceChannel.permissionOverwrites.edit(targetMember.id, { Connect: false });
      try {
        await targetMember.voice.setChannel(null);
      } catch (err) {
        await voiceChannel.permissionOverwrites.edit(targetMember.id, { Connect: null }).catch(() => {});
        throw err;
      }
      return { success: true, user: targetMember.displayName, mention: `<@${targetMember.id}>`, channel: voiceChannel.name };
    } catch (err) { return { success: false, error: err.message }; }
  }

  if (name === 'create_channel') {
    if (!canManageChannels(caller)) return { success: false, error: 'Ghir staff li 3ndhom Manage Channels.' };
    if (!args.name) return { success: false, error: 'Smit channel darori.' };
    try { const newChannel = await message.guild.channels.create({ name: args.name, type: (args.type === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText) }); return { success: true, name: newChannel.name, mention: `<#${newChannel.id}>`, type: args.type }; } catch (err) { return { success: false, error: err.message }; }
  }

  if (name === 'create_role') {
    if (!canManageRoles(caller)) return { success: false, error: 'Ghir staff li 3ndhom Manage Roles.' };
    if (!args.name) return { success: false, error: 'Smit role darori.' };
    try { const role = await message.guild.roles.create({ name: args.name }); return { success: true, name: role.name, mention: `<@&${role.id}>` }; } catch (err) { return { success: false, error: err.message }; }
  }

  if (name === 'move_all_members') {
    if (!canCallerMove(caller)) return { success: false, error: 'Ma 3ndekch permission.' };
    const destinationQuery = args.destination_channel;
    let dest = destinationQuery && !['here', 'me', 'my channel', 'my voice', 'hna', 'l hna'].includes(destinationQuery.toLowerCase().trim())
      ? findVoiceChannel(message.guild, destinationQuery)
      : caller.voice.channel;
    if (!dest) return { success: false, error: 'Ma lqitch destination voice channel.' };
    const source = findVoiceChannel(message.guild, args.source_channel);
    if (!source || source.id === dest.id) return { success: false, error: 'Ma lqitch source.' };
    let moved = 0;
    const errors = [];
    for (const m of Array.from(source.members.values())) {
      try { await m.voice.setChannel(dest); moved++; }
      catch (e) { errors.push(`${m.displayName}: ${e.message}`); }
    }
    return { success: errors.length === 0, moved, source: source.name, dest: dest.name, ...(errors.length ? { error: `Moved ${moved}; failed for ${errors.length}: ${errors.slice(0, 3).join('; ')}` } : {}) };
  }

  if (name === 'move_members') {
    if (!canCallerMove(caller)) return { success: false, error: 'Ma 3ndekch permission.' };
    const members = await resolveMembers(message.guild, args.target_users, message.mentions, message.client.user.id);
    if (members.length === 0) return { success: false, error: 'Ma lqitch chi members bach n7errek.' };
    const destinationQuery = args.destination;
    const dest = destinationQuery && !['here', 'me', 'my channel', 'my voice', 'hna', 'l hna'].includes(destinationQuery.toLowerCase().trim())
      ? findVoiceChannel(message.guild, destinationQuery)
      : caller.voice.channel;
    if (!dest) return { success: false, error: 'Ma lqitch destination voice channel.' };
    let moved = 0;
    const errors = [];
    for (const m of members) {
      try { await m.voice.setChannel(dest); moved++; }
      catch (e) { errors.push(`${m.displayName}: ${e.message}`); }
    }
    return { success: errors.length === 0, moved, dest: dest.name, ...(errors.length ? { error: `Moved ${moved}; failed for ${errors.length}: ${errors.slice(0, 3).join('; ')}` } : {}) };
  }

  if (name === 'dm_members') {
    if (!canCallerModerate(caller)) return { success: false, error: 'Ghir staff.' };
    const members = await resolveMembers(message.guild, args.target_users, message.mentions, message.client.user.id);
    if (members.length === 0) return { success: false, error: 'Ma lqitch chi members bach nsift lihom.' };
    if (!args.message_text || !args.message_text.trim()) return { success: false, error: 'Message khawya.' };
    let sent = 0;
    for (const m of members) { try { await m.send(args.message_text); sent++; } catch (e) {} }
    return { success: true, sent };
  }

  if (name === 'start_verification') {
    let target = caller;
    if (args.target_user) {
      target = await findTargetMember(message.guild, args.target_user, message.mentions, message.client.user.id);
      if (!target) return { success: false, error: 'Ma lqitch had member.' };
      const isStaff = (STAFF_ROLE_ID && caller.roles.cache.has(STAFF_ROLE_ID)) || caller.permissions.has(PermissionsBitField.Flags.Administrator);
      if (target.id !== caller.id && !isStaff) return { success: false, error: 'T9der t-requesti verification ghir l rassek.' };
    }
    return await startVerification(message.guild, target);
  }

  if (name === 'join_voice') {
    if (!distube) return { success: false, error: 'Music missing.' };
    const ch = args.channel && !['here', 'me', 'my channel', 'hna'].includes(args.channel.toLowerCase().trim())
      ? findVoiceChannel(message.guild, args.channel)
      : caller.voice.channel;
    if (!ch) return { success: false, error: 'Ma lqitch voice channel; dkhol l voice aw 3tini smitha.' };
    try {
      await distube.voices.join(ch, { selfDeaf: false });
      const voice = distube.voices.get(message.guild.id);
      if (voice) listenInVoiceChannel(message.guild, voice.connection, message.channel);
      return { success: true, channel: ch.name };
    } catch (e) { return { success: false, error: e.message }; }
  }

  // ==== NON-BLOCKING MUSIC PLAY (FIXES 15s LATENCY) ====
  if (name === 'play_music') {
    const query = (args.query || '').trim();
    if (!query) return { success: false, error: 'Kteb smit l-ghnya.' };
    if (query.length > 500) return { success: false, error: 'Query twila bzaf; khas-ha tkoun 500 character aw a9al.' };
    if (!distube) return { success: false, error: 'Music missing.' };
    const targetChannel = caller.voice.channel || message.guild.members.me.voice.channel;
    if (!targetChannel) return { success: false, error: 'Dkhol l voice b3da.' };
    
    // FIRE AND FORGET - Do not await this Promise!
    distube.play(targetChannel, query, { member: caller, textChannel: message.channel, message })
      .catch(e => console.error(`[Background Music Error]: ${e.message}`));
    
    return { success: true, query };
  }

  if (name === 'skip_music') {
    if (!distube) return { success: false, error: 'Music missing.' };
    try { const q = distube.getQueue(message.guild); if (!q) return { success: false, error: 'Queue empty.' }; await q.skip(); return { success: true }; } catch (e) { return { success: false, error: e.message }; }
  }

  if (name === 'stop_music') {
    if (!distube) return { success: false, error: 'Music missing.' };
    try { const q = distube.getQueue(message.guild); if (q) q.stop(); return { success: true }; } catch (e) { return { success: false, error: e.message }; }
  }

  if (name === 'leave_music') {
    if (!distube) return { success: false, error: 'Music missing.' };
    try { const q = distube.getQueue(message.guild); if (q) q.stop(); await distube.voices.leave(message.guild); return { success: true }; } catch (e) { return { success: false, error: e.message }; }
  }

  if (name === 'delete_channel') {
    if (!canManageChannels(caller)) return { success: false, error: 'Ma 3ndekch Manage Channels.' };
    const target = findChannel(message.guild, args.channel_name);
    if (!target) return { success: false, error: `Channel ma kaynch.` };
    try { const n = target.name; await target.delete(); return { success: true, name: n }; } catch (e) { return { success: false, error: e.message }; }
  }

  if (name === 'delete_role') {
    if (!canManageRoles(caller)) return { success: false, error: 'Ma 3ndekch Manage Roles.' };
    const role = findRole(message.guild, args.role_name);
    if (!role) return { success: false, error: `Role ma kaynch.` };
    const roleCheck = checkRoleManagementPermissions(caller, role, message.guild);
    if (!roleCheck.allowed) return { success: false, error: roleCheck.error };
    try { const n = role.name; await role.delete(); return { success: true, name: n }; } catch (e) { return { success: false, error: e.message }; }
  }

  return { success: false, error: `Unknown action: ${name}` };
}

// 4. Handle Messages & Commands
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  const botMention = client.user ? new RegExp(`<@!?${client.user.id}>`, 'g') : null;
  const isMentioned = botMention ? botMention.test(message.content) : false;

  // Recent bot messages are already cached. Avoid an extra Discord API fetch
  // on ordinary replies; explicit mentions still always trigger the AI.
  const referencedMessage = message.reference?.messageId
    ? message.channel.messages.cache.get(message.reference.messageId)
    : null;
  const isReplyToBot = referencedMessage?.author.id === client.user.id;

  if (isMentioned || isReplyToBot) {
    if (!genAI) return message.reply('Sme7 lia, AI mazal ma tf3elatch.');

    const promptText = (botMention ? message.content.replace(botMention, '') : message.content).trim();
    if (!promptText) return message.reply('Ach bghiti tswelni? Kteb sou2al 🙂');
    if (promptText.length > AI_MAX_QUESTION_CHARS) return message.reply(`Sou2al twil bzaf 😅 7awel tkhtasro l ${AI_MAX_QUESTION_CHARS} 7arf.`);

    const requestedAddressForm = getAddressFormPreference(promptText);
    if (requestedAddressForm) {
      userAddressForms.set(message.author.id, requestedAddressForm);
      const form = requestedAddressForm === 'feminine' ? 'nti' : 'nta';
      return message.reply(`Safi, ghadi nkhatbek b ${form} mn daba 🙂`);
    }

    // Handle clear channel controls deterministically so the bot cannot claim
    // success based on generated text without actually changing Discord state.
    const directIntent = getDirectChannelIntent(promptText, message);
    if (directIntent) {
      const toolResult = await executeDiscordTool(directIntent.name, directIntent.args, message);
      console.log(`[AI Direct Action] ${directIntent.name} ${toolResult.success ? 'succeeded' : `failed: ${toolResult.error}`}`);
      const confirmation = formatToolSummary([{ name: directIntent.name, result: toolResult }]);
      return message.reply({ content: confirmation, allowedMentions: { parse: [] } });
    }

    const now = Date.now();
    for (const [userId, timestamp] of aiUserCooldowns) {
      if (now - timestamp >= AI_COOLDOWN_MS) aiUserCooldowns.delete(userId);
    }
    const lastRequest = aiUserCooldowns.get(message.author.id) || 0;
    if (now - lastRequest < AI_COOLDOWN_MS) return message.reply('3tini ghir chwia w nrje3 njawbek 🙂');
    aiUserCooldowns.set(message.author.id, now);

    message.channel.sendTyping().catch(() => {});

    let channelContext = '';
    const cachedMsgs = Array.from(message.channel.messages.cache.values())
      .filter(m => m.id !== message.id && (!m.author.bot || m.author.id === client.user.id))
      .filter(m => (Date.now() - m.createdTimestamp) < 30 * 60 * 1000)
      .slice(-6);

    if (cachedMsgs.length > 0) {
      channelContext = cachedMsgs
        .map(m => `[${m.author.id === client.user.id ? 'kho Kokiee' : (m.member?.displayName || m.author.username)}]: ${botMention ? m.content.replace(botMention, '').trim() : m.content.trim()}`)
        .filter(line => line.trim().length > 0)
        .join('\n');
    }

    const callerName = message.member?.displayName || message.author.username;
    if (channelContext.length > AI_MAX_CONTEXT_CHARS) channelContext = channelContext.slice(-AI_MAX_CONTEXT_CHARS);
    const finalPrompt = channelContext ? `Recent channel conversation:\n${channelContext}\n\nCurrent message from [${callerName}]:\n${promptText}` : `[${callerName}]: ${promptText}`;

    const preferredAddressForm = userAddressForms.get(message.author.id);
    const addressFormInstruction = preferredAddressForm
      ? `The current speaker explicitly prefers ${preferredAddressForm === 'feminine' ? 'feminine address (nti)' : 'masculine address (nta)'}. Use that form for this speaker. Do not apply it to other people.`
      : 'Never guess a person’s gender from their name, avatar, or writing. Use neutral phrasing for the current speaker; if using nta/nti matters, politely ask which form they prefer.';
    const systemInstruction = `You are kho Kokiee, an original, strict-but-funny Moroccan Darija Discord moderator with dramatic referee energy. Do not imitate or claim to be any real historical leader or extremist figure, and do not use extremist slogans or propaganda.
Always reply in Moroccan Darija written with Latin letters/Arabizi (like "salam cv", "a sat", "wa3er"); never use Arabic script. Sound casual and human, not formal or robotic. Keep normal replies short (usually 1-2 sentences), use a quick joke when it fits, and don't force jokes into serious conversations.
${addressFormInstruction}
Be confident and firm about server rules without humiliating members, making threats, or using slurs. Do not make sexual comments about real people.
You may use casual Darija profanity sparingly as playful, situation-directed banter (for example, "ya l kalb"  about a frustrating situation or your own mistake). Never direct insults, humiliation, slurs, or profanity at a server member; soften it if the context is unclear.
When a user clearly asks you to lock/close or open/unlock a channel, call manage_current_channel without asking them to use a prefix command. Treat "tap", "chat", or "text channel" as the current text channel unless they are in a bot-created temporary voice room; then "tap" means that voice room. Only that voice room's owner may lock or open it; reject requests from everyone else, including staff. Lock/open text channels only for members with Manage Channels/staff permission. If they ask for a new personal voice room, call create_personal_voice_room; they must be in voice, and the tool creates the room and moves them into it. Use rename_voice_room to change the caller's current room name, and reject_voice_member to deny a mentioned member entry and disconnect them from that room. Phrases like "lock the tap", "open the tap", "7ol tap", and "sedd tap" are direct requests. Never say an action succeeded unless its tool result is success.
Use the provided Discord tools only for actions the current user clearly requested. Never decide by yourself to mute, unmute, remove, or punish anyone. Mute/unmute require an explicit request and the caller's staff/moderation permission; if not requested or authorized, refuse. You do not have a ban action. For regular chat, answer directly.`;

    let streamedMessage = null;
    const aiStartedAt = Date.now();
    try {
      const candidates = getModelCandidates();
      let result = null;
      let chat = null;

      // Only iterate through valid flash models to completely avoid 503/400 crashes
      for (const candidate of candidates) {
        try {
          console.log(`[AI] Processing query from ${callerName} using ${candidate}`);
          const model = genAI.getGenerativeModel({ model: candidate, systemInstruction, tools: discordTools });
          
          chat = model.startChat({
            generationConfig: {
              maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
              temperature: 0.7,
            },
          });

          const streamResult = await chat.sendMessageStream(finalPrompt);
          let streamedText = '';
          let lastEditAt = 0;
          let firstTextLogged = false;

          for await (const chunk of streamResult.stream) {
            let chunkText = '';
            try { chunkText = chunk.text(); } catch (e) {}
            if (!chunkText) continue;

            streamedText += chunkText;
            if (!firstTextLogged) {
              firstTextLogged = true;
              console.log(`[AI Timing] First text chunk in ${Date.now() - aiStartedAt}ms (${candidate})`);
            }

            const visibleText = streamedText.length > 1996 ? `${streamedText.slice(0, 1993)}...` : streamedText;
            if (!streamedMessage) {
              streamedMessage = await message.reply({
                content: visibleText,
                allowedMentions: { parse: [] },
              });
              lastEditAt = Date.now();
            } else if (Date.now() - lastEditAt >= 1200) {
              await streamedMessage.edit({
                content: visibleText,
                allowedMentions: { parse: [] },
              }).catch(e => console.warn(`[AI] Could not update streamed reply: ${e.message}`));
              lastEditAt = Date.now();
            }
          }

          result = { response: await streamResult.response };
          break; // Break on success!
        } catch (err) {
          console.warn(`[AI] Model ${candidate} failed (${err.message})`);
          if (err.message && err.message.includes('404')) {
            availableModelsCache = availableModelsCache.filter(m => m !== candidate);
          } else {
            // Retrying the same request on multiple models adds latency and
            // can amplify quota/rate-limit errors. Only fall back for 404s.
            break;
          }
        }
      }

      if (!result || !chat) throw new Error('All Gemini models failed or overloaded.');

      let responseText = '';
      const executedTools = [];
      const isMultiStep = /\b(then|after that|w mn b3d|mn b3d|moraha)\b/i.test(promptText);

      // Loop for multiple tool calls
      for (let round = 0; round < 6; round++) {
        const functionCalls = result.response.functionCalls();
        if (!functionCalls || functionCalls.length === 0) {
          responseText = extractResponseText(result.response);
          break;
        }

        const functionResponses = [];
        for (const call of functionCalls) {
          console.log(`[AI Tool] Model requested ${call.name} with args:`, call.args);
          const toolResult = await executeDiscordTool(call.name, call.args, message);
          executedTools.push({ name: call.name, result: toolResult });
          functionResponses.push({ functionResponse: { name: call.name, response: toolResult } });
        }

        // Return instantly if no multi-step chain was requested
        if (!isMultiStep) {
          responseText = formatToolSummary(executedTools);
          break;
        }

        result = await chat.sendMessage(functionResponses);
      }

      if (!responseText && executedTools.length > 0) responseText = formatToolSummary(executedTools);
      if (!responseText) throw new Error('Empty response');
      if (responseText.length > 2000) responseText = responseText.substring(0, 1996) + '...';

      console.log(`[AI Timing] Completed in ${Date.now() - aiStartedAt}ms (${responseText.length} chars)`);
      if (streamedMessage) {
        await streamedMessage.edit({ content: responseText, allowedMentions: { parse: [] } });
      } else {
        await message.reply({ content: responseText, allowedMentions: { parse: [] } });
      }
      // The AI response remains instant in text; voice generation runs separately.
      const voiceActionConflicts = executedTools.some(({ name }) => name === 'play_music' || name === 'leave_music');
      if (!voiceActionConflicts) {
        speakVoiceReply(message, responseText).catch(error =>
          console.warn(`[Voice TTS] Background speech failed: ${error.message}`),
        );
      }
    } catch (err) {
      console.error(`Gemini API Error: ${err.message}`);
      aiUserCooldowns.delete(message.author.id);
      const errorReply = '😅 Sme7 lia, w9e3 mochkil f ljawab. 3awed jereb mn b3d chwia.';
      if (streamedMessage) await streamedMessage.edit(errorReply).catch(() => {});
      else await message.reply(errorReply).catch(() => {});
    }
    return;
  }

  // DIRECT MUSIC COMMANDS
  const msgLower = message.content.toLowerCase();

  if (msgLower.startsWith('play ')) {
    const musicQuery = message.content.slice(5).trim();
    if (!distube) return message.reply('❌ Music ma kaynch.');
    if (!message.member.voice.channel) return message.reply('❌ Khassek tkon f voice channel bach tplayi l-music.');
    if (!musicQuery) return message.reply('❌ Kteb smit l-ghnya. Mithal: `play chkoun li gal`');
    if (musicQuery.length > 500) return message.reply('❌ Sou2al twil bzaf. Khtasar smit l-ghnya aw sift link.');
    
    // ==== NON-BLOCKING PLAY (Instant Response) ====
    distube.play(message.member.voice.channel, musicQuery, {
      member: message.member,
      textChannel: message.channel,
      message,
    }).catch(e => {
      message.channel.send(`❌ Ma qdertch nplayi: ${e.message}`).catch(()=>{});
    });
    
    return message.reply('🔎 3la rassi w 3ini, ana njibha daba...');
  }

  if (msgLower === 'stop' || msgLower === 'stop music') {
    if (!distube) return message.reply('❌ Music ma kaynch.');
    const q = distube.getQueue(message.guild);
    if (!q) return message.reply('❌ Ma kaynch chi music khdama daba.');
    q.stop();
    return message.reply('⏹️ Safi w9eft l-music.');
  }

  if (msgLower === 'skip' || msgLower === 'skip music') {
    if (!distube) return message.reply('❌ Music ma kaynch.');
    const q = distube.getQueue(message.guild);
    if (!q) return message.reply('❌ Ma kaynch chi music khdama.');
    try { await q.skip(); message.reply('⏭️ Dozt l-ghnya.'); } catch (e) { q.stop(); message.reply('⏹️ Hada akher track.'); }
  }

  if (msgLower === 'leave voice' || msgLower === 'leave music') {
    if (!distube) return message.reply('❌ Music ma kaynch.');
    const q = distube.getQueue(message.guild);
    if (q) q.stop();
    await distube.voices.leave(message.guild);
    return message.reply('👋 Thllaw!');
  }

  // C. VOICE ROOM CONTROL COMMANDS
  if (!/^\.a(?:\s|$)/i.test(message.content)) return;
  const args = message.content.slice(2).trim().split(/ +/);
  const command = (args.shift() || '').toLowerCase();
  if (!command) return message.reply('❌ Kteb command b7al `.a lock` aw `.a name smiya`.');
  const voiceChannel = message.member?.voice?.channel;

  if (!voiceChannel) return message.reply('❌ You must be connected to a voice channel.');

  if (command === 'claim') {
    if (!voiceChannel.name.startsWith('🔊 ') && !voiceChannel.name.includes("'s Room")) {
      return message.reply('❌ T9der tclaim ghir custom room dyal bot.');
    }
    const existingOwnerOverwrite = voiceChannel.permissionOverwrites.cache.get(message.author.id);
    if (!existingOwnerOverwrite?.allow.has(PermissionsBitField.Flags.ManageChannels)) {
      return message.reply('❌ Ghir moul l-room y9der yclaimiha.');
    }
    roomOwners.set(voiceChannel.id, message.author.id);
    await voiceChannel.permissionOverwrites.edit(message.author.id, { ManageChannels: true, Connect: true, Speak: true, SendMessages: true });
    return message.reply('✅ Room claimed.');
  }

  if (roomOwners.get(voiceChannel.id) !== message.author.id) return message.reply('❌ You do not own this room.');

  try {
    if (command === 'name') {
      const newName = args.join(' ').trim();
      if (!newName) return message.reply('❌ Kteb smiya jdida: `.a name smiya`.');
      await voiceChannel.setName(`🔊 ${newName}`);
      message.reply('✅ Room renamed.');
    }
    else if (command === 'lock') { await voiceChannel.permissionOverwrites.edit(message.guild.id, { Connect: false }); message.reply('🔒 Room locked.'); }
    else if (command === 'unlock') { await voiceChannel.permissionOverwrites.edit(message.guild.id, { Connect: null }); message.reply('🔓 Room unlocked.'); }
    else if (command === 'reject') {
      const target = await findTargetMember(message.guild, args.slice(1).join(' '), message.mentions, client.user.id);
      if (!target) return message.reply('❌ Mention l-member li bghiti t-rejecti.');
      if (target.id === message.author.id) return message.reply('❌ Ma t9drch t-rejecti rassek.');
      if (target.voice.channelId !== voiceChannel.id) return message.reply('❌ Had member ma kaynach f room dyalk.');
      await voiceChannel.permissionOverwrites.edit(target.id, { Connect: false });
      try {
        await target.voice.setChannel(null);
      } catch (err) {
        await voiceChannel.permissionOverwrites.edit(target.id, { Connect: null }).catch(() => {});
        throw err;
      }
      message.reply(`✅ Khrejt ${target} mn room dyalk w seddt 3lih dkhoul.`);
    }
    else if (command === 'limit') {
      const limit = Number(args[0]);
      if (!Number.isInteger(limit) || limit < 0 || limit > 99) return message.reply('❌ L-limit khaso ykon bin 0 w 99.');
      await voiceChannel.setUserLimit(limit);
      message.reply('✅ Limit updated.');
    } else return message.reply('❌ Had command ma kaynach. Jرب `.a lock`, `.a unlock`, `.a name`, ola `.a limit`.');
  } catch (err) {
    console.error(`[Voice Room] ${command} failed: ${err.message}`);
    message.reply('❌ Ma qdertch ndir had l-command. T2ekked mn permissions dyal bot.').catch(() => {});
  }
});

client.login(process.env.DISCORD_TOKEN);
