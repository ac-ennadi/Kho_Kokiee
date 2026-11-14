const { PermissionsBitField } = require('discord.js');

function registerMessageHandler({ client, distube, config, gemini, discord, voice }) {
  const GEMINI_API_KEY = config.GEMINI_API_KEY;
  const genAI = gemini.genAI;
  const aiUserCooldowns = new Map();
  const AI_COOLDOWN_MS = 2000;
  const AI_MAX_QUESTION_CHARS = 1500;
  const AI_MAX_CONTEXT_CHARS = 1200;
  const AI_MAX_OUTPUT_TOKENS = 120;
  const { roomOwners, userAddressForms, discordTools, findTargetMember, extractResponseText, formatToolSummary, getDirectChannelIntent, getAddressFormPreference, executeDiscordTool } = discord;

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
      const candidates = gemini.getModelCandidates();
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
            gemini.excludeModel(candidate);
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
        voiceService.speakVoiceReply(message, responseText).catch(error =>
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


}

module.exports = { registerMessageHandler };
