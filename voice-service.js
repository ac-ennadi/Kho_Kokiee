const { PermissionsBitField } = require('discord.js');

function createVoiceService({ client, distube, config, gemini, discord }) {
  const { GEMINI_API_KEY, GEMINI_TTS_MODEL, GEMINI_TTS_VOICE, AZURE_SPEECH_KEY, AZURE_SPEECH_REGION, AZURE_SPEECH_VOICE, HADRA_TTS_URL, VOICE_TTS_ENABLED } = config;
  const voiceReplyLocks = new Set();
  const voiceConversationLocks = new Set();
  const voiceListeners = new Map();
  const voiceReplyChannels = new Map();
  const voiceDialogContexts = new Map();
  let voiceTtsQuotaBackoffUntil = 0;
  let lastVoiceTtsQuotaNoticeAt = 0;
  let voiceListenBackoffUntil = 0;
  let lastVoiceListenQuotaNoticeAt = 0;
  let hadraTtsBackoffUntil = 0;
  const getModelCandidates = gemini.getModelCandidates;
  const { getVoiceCommandIntent, executeDiscordTool, formatToolSummary } = discord;

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

async function toMoroccanArabicScript(text) {
  if (!GEMINI_API_KEY || !text || /[\u0600-\u06FF]/.test(text)) return text;
  const model = getModelCandidates()[0];
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        contents: [{ parts: [{ text: `Rewrite this Moroccan Darija sentence in Arabic script for a Moroccan Arabic voice to speak. Preserve the same Darija words, meaning, and casual tone; transliterate the script, do not translate it into formal Arabic, add wording, or explain. Return only the Arabic-script sentence:\n${text.slice(0, 240)}` }] }],
        generationConfig: { maxOutputTokens: 90, temperature: 0.1 },
      }),
    },
  );
  if (!response.ok) throw new Error(`Darija speech transliteration returned HTTP ${response.status}.`);
  const data = await response.json();
  const arabicText = (data.candidates?.[0]?.content?.parts || []).map(part => part.text || '').join(' ').trim();
  return /[\u0600-\u06FF]/.test(arabicText) ? arabicText : text;
}

async function speakVoiceReply(message, text, speechTextArabic = null) {
  if (!VOICE_TTS_ENABLED || (!GEMINI_API_KEY && !(AZURE_SPEECH_KEY && AZURE_SPEECH_REGION) && !HADRA_TTS_URL) || !distube || !message.guild) return false;
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
  let playingHandler;
  let spoken = false;
  const guildId = message.guild.id;
  voiceReplyLocks.add(guildId);

  try {
    const { createAudioResource, StreamType,
      AudioPlayerStatus, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
    const botMember = message.guild.members.me;
    const voicePermissions = botMember && voiceChannel.permissionsFor(botMember);
    if (!voicePermissions?.has(PermissionsBitField.Flags.Speak)) {
      throw new Error(`Bot is missing Speak permission in voice channel ${voiceChannel.id}.`);
    }
    await distube.voices.join(voiceChannel, { selfDeaf: false });
    const voice = distube.voices.get(guildId);
    connection = voice?.connection;
    if (!connection) throw new Error('Discord voice connection was not available after joining.');
    await entersState(connection, VoiceConnectionStatus.Ready, 8000);
    listenInVoiceChannel(message.guild, connection, message.channel);

    // Keep spoken answers short so they are quick and use fewer TTS tokens.
    const spokenText = text.replace(/<@!?\d+>/g, '').slice(0, 240).trim();
    if (!spokenText) return;
    let wavBuffer = null;
    const providerErrors = [];
    let arabicSpeechText = String(speechTextArabic || '').trim();

    // Prefer Gemini when available, then use the Darija-focused HADRA model,
    // and finally Azure as the compatibility fallback.
    if (GEMINI_API_KEY && Date.now() >= voiceTtsQuotaBackoffUntil) {
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TTS_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(15000),
            body: JSON.stringify({
              contents: [{ parts: [{
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
        if (!response.ok) {
          const errorDetails = (await response.text()).slice(0, 300);
          if (response.status === 429) voiceTtsQuotaBackoffUntil = Date.now() + 60 * 60 * 1000;
          throw new Error(`Gemini TTS returned HTTP ${response.status}: ${errorDetails}`);
        }
        const data = await response.json();
        const audioPart = data.candidates?.[0]?.content?.parts?.find(part => part.inlineData?.data);
        if (!audioPart) throw new Error('Gemini TTS response did not include audio.');
        const audioBuffer = Buffer.from(audioPart.inlineData.data, 'base64');
        wavBuffer = audioPart.inlineData.mimeType?.includes('wav') ? audioBuffer : makePcmWav(audioBuffer);
        console.log(`[Voice TTS] Synthesized reply with Gemini voice ${GEMINI_TTS_VOICE}.`);
      } catch (error) {
        providerErrors.push(error.message);
        console.warn(`[Voice TTS] Gemini unavailable; trying HADRA/Azure fallback: ${error.message}`);
      }
    }

    if (!wavBuffer && HADRA_TTS_URL && Date.now() >= hadraTtsBackoffUntil) {
      try {
        if (!/[\u0600-\u06FF]/.test(arabicSpeechText)) arabicSpeechText = await toMoroccanArabicScript(spokenText);
        const hadraResponse = await fetch(HADRA_TTS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: arabicSpeechText, format: 'wav' }),
          signal: AbortSignal.timeout(7000),
        });
        if (!hadraResponse.ok) throw new Error(`HADRA returned HTTP ${hadraResponse.status}: ${(await hadraResponse.text()).slice(0, 200)}`);
        wavBuffer = Buffer.from(await hadraResponse.arrayBuffer());
        if (wavBuffer.length < 44 || wavBuffer.toString('ascii', 0, 4) !== 'RIFF') throw new Error('HADRA returned an invalid WAV response.');
        console.log('[Voice TTS] Synthesized reply with HADRA Moroccan Darija.');
      } catch (error) {
        hadraTtsBackoffUntil = Date.now() + 5 * 60 * 1000;
        providerErrors.push(error.message);
        console.warn(`[Voice TTS] HADRA unavailable; trying Azure fallback: ${error.message}`);
      }
    }

    if (!wavBuffer && AZURE_SPEECH_KEY && AZURE_SPEECH_REGION) {
      try {
        if (!/[\u0600-\u06FF]/.test(arabicSpeechText)) arabicSpeechText = await toMoroccanArabicScript(spokenText);
        const safeText = arabicSpeechText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
        const ssml = `<speak version="1.0" xml:lang="ar-MA"><voice name="${AZURE_SPEECH_VOICE}" xml:lang="ar-MA">${safeText}</voice></speak>`;
        const azureResponse = await fetch(`https://${AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': AZURE_SPEECH_KEY,
            'Content-Type': 'application/ssml+xml',
            'X-Microsoft-OutputFormat': 'riff-24khz-16bit-mono-pcm',
            'User-Agent': 'KhoKokieeDiscordBot',
          },
          body: ssml,
          signal: AbortSignal.timeout(15000),
        });
        if (!azureResponse.ok) throw new Error(`Azure Speech returned HTTP ${azureResponse.status}: ${(await azureResponse.text()).slice(0, 250)}`);
        wavBuffer = Buffer.from(await azureResponse.arrayBuffer());
        console.log(`[Voice TTS] Synthesized reply with Azure voice ${AZURE_SPEECH_VOICE}.`);
      } catch (error) {
        providerErrors.push(error.message);
        console.warn(`[Voice TTS] Azure provider failed: ${error.message}`);
      }
    }
    if (!wavBuffer) throw new Error(providerErrors.join(' | ') || 'No TTS provider is configured or its quota is unavailable.');
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
        player.off(AudioPlayerStatus.Playing, playingHandler);
        player.off('error', errorHandler);
        err ? reject(err) : resolve();
      };
      idleHandler = () => finish();
      playingHandler = () => console.log(`[Voice TTS] Audio playback started in ${guildId}.`);
      errorHandler = error => finish(error);
      player.once(AudioPlayerStatus.Idle, idleHandler);
      player.once(AudioPlayerStatus.Playing, playingHandler);
      player.once('error', errorHandler);
      player.play(resource);
    });
    spoken = true;
  } catch (error) {
    console.warn(`[Voice TTS] Could not speak reply: ${error.message}`);
    if (/HTTP 429/.test(error.message)) {
      if (Date.now() - lastVoiceTtsQuotaNoticeAt > 60 * 60 * 1000 && message.channel?.isTextBased()) {
        lastVoiceTtsQuotaNoticeAt = Date.now();
        message.channel.send('Sout dyali wa9ef daba 7it Gemini TTS quota salat; ljawab kaybqa yban f chat.').catch(() => {});
      }
    }
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
    if (Date.now() < voiceListenBackoffUntil
      || userId === client.user.id
      || voiceReplyLocks.has(guild.id)
      || voiceConversationLocks.has(guild.id)) return;
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
        const now = Date.now();
        if (error.status === 429) {
          voiceListenBackoffUntil = now + 60 * 60 * 1000;
          console.warn('[Voice Listen] Gemini quota exhausted; pausing voice understanding for 1 hour.');
          if (now - lastVoiceListenQuotaNoticeAt > 60 * 60 * 1000) {
            lastVoiceListenQuotaNoticeAt = now;
            const textChannel = voiceReplyChannels.get(guild.id);
            if (textChannel?.isTextBased()) {
              textChannel.send('Sme7 lia, quota dyal voice AI salat daba. Ghadi n3awed njarrab mn b3d.').catch(() => {});
            }
          }
          return;
        }
        if (error.status === 503) voiceListenBackoffUntil = now + 30 * 1000;
        console.warn(`[Voice Listen] Could not answer: ${error.message}`);
        if (error.status !== 503) voiceListenBackoffUntil = now + 10 * 1000;
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
  const contextKey = `${guild.id}:${member.id}`;
  const previousDialog = voiceDialogContexts.get(contextKey);
  const recentTurns = previousDialog && previousDialog.expiresAt > Date.now()
    ? previousDialog.turns
    : [];
  const recentContext = recentTurns.map(turn => `${turn.role}: ${turn.text}`).join('\n').slice(-900);
  const contextInstruction = recentContext
    ? `Recent voice conversation with this speaker:\n${recentContext}\nUse this context to tell whether the new speech is a follow-up to you.`
    : 'There is no recent voice conversation with this speaker yet.';
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        contents: [{ parts: [
          { text: `You are Kho Kokiee in a Discord voice channel. Do not use a wake word, bot name, or special trigger. Decide from what the person says and the recent context whether they are talking to you. If they ask you a question, give you a request, greet you, or continue a recent exchange with you, mark addressed=true. Mark addressed=false only when it is clearly conversation between other people or unrelated background speech. If unclear, favor answering when the utterance sounds like a question or follows your last reply. Return only JSON with exactly these fields: {"addressed": boolean, "transcript": "short transcript of the speaker", "reply": "one short reply in Moroccan Darija written with Latin letters (Arabizi), like salam cv; empty when addressed is false", "speech_text_ar": "the same reply in Moroccan Darija written in Arabic script for speech, empty when addressed is false"}. Keep reply in Latin letters and speech_text_ar in Arabic script; preserve the same Darija meaning and casual wording in both. ${contextInstruction} Speaker: ${member.displayName}.` },
          { inlineData: { mimeType: 'audio/wav', data: makePcmWav(pcm, 48000, 2).toString('base64') } },
        ] }],
        generationConfig: { maxOutputTokens: 180, temperature: 0.4, responseMimeType: 'application/json' },
      }),
    },
  );
  if (!response.ok) {
    const error = new Error(`Gemini audio returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    error.status = response.status;
    throw error;
  }
  const data = await response.json();
  const rawAnswer = (data.candidates?.[0]?.content?.parts || [])
    .map(part => part.text || '')
    .join(' ')
    .trim();
  let result;
  try {
    result = JSON.parse(rawAnswer.replace(/^```(?:json)?\s*|\s*```$/gi, '').trim());
  } catch {
    // Gracefully accept a plain-text answer if a model ignores JSON mode.
    if (/^\[IGNORE\]/i.test(rawAnswer)) {
      console.log(`[Voice Listen] Ignored speech not addressed to the bot in ${guild.id}.`);
      return;
    }
    result = { addressed: true, transcript: '', reply: rawAnswer };
  }
  if (result.addressed === false) {
    console.log(`[Voice Listen] Ignored speech not addressed to the bot in ${guild.id}.`);
    return;
  }
  let answer = String(result.reply || '').trim().slice(0, 240);
  if (!answer) throw new Error('Gemini returned no answer for the voice message.');
  const speechTextArabic = String(result.speech_text_ar || '').trim().slice(0, 300);
  const transcript = String(result.transcript || '').trim().slice(0, 240);
  const voiceIntent = getVoiceCommandIntent(transcript);
  if (voiceIntent) {
    const textChannel = voiceReplyChannels.get(guild.id) || guild.systemChannel;
    const commandMessage = {
      guild,
      member,
      author: member.user,
      client,
      channel: textChannel,
      content: transcript,
      mentions: { members: { find: () => undefined } },
    };
    const toolResult = await executeDiscordTool(voiceIntent.name, voiceIntent.args, commandMessage);
    console.log(`[Voice Tool] ${voiceIntent.name} from ${member.displayName}: ${toolResult.success ? 'succeeded' : `failed: ${toolResult.error}`}`);
    answer = formatToolSummary([{ name: voiceIntent.name, result: toolResult }]).slice(0, 240);
  }
  voiceDialogContexts.set(contextKey, {
    expiresAt: Date.now() + 2 * 60 * 1000,
    turns: [...recentTurns, ...(transcript ? [{ role: 'User', text: transcript }] : []), { role: 'Kho Kokiee', text: answer }].slice(-6),
  });
  const textChannel = voiceReplyChannels.get(guild.id);
  if (textChannel?.isTextBased()) {
    await textChannel.send({ content: `${member}, ${answer}`, allowedMentions: { parse: [], users: [member.id] } }).catch(() => {});
  }
  // Playback can succeed even when DisTube changes player state before the
  // completion check settles. Keep failures in logs instead of sending a
  // misleading text warning after the audible answer.
  const speechActionConflicts = voiceIntent?.name === 'play_music' || voiceIntent?.name === 'leave_music';
  if (!speechActionConflicts) await speakVoiceReply({ guild, member, channel: textChannel }, answer, voiceIntent ? null : speechTextArabic);
}


  return { speakVoiceReply, listenInVoiceChannel };
}

module.exports = { createVoiceService };
