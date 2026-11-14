const { ChannelType, PermissionsBitField, AuditLogEvent } = require('discord.js');

function createDiscordService({ client, distube, config }) {
  const { ROLE_ID, NOT_VERIFIED_ROLE_ID, TARGET_VC_ID, STAFF_ROLE_ID, MOVE_ROLE_ID, CATEGORY_ID, CREATE_VC_ID, CREATE_CATEGORY_ID, LOG_CHANNEL_ID, GEMINI_API_KEY } = config;
  const roomOwners = new Map();
  const userAddressForms = new Map();
  let listenInVoiceChannel = () => {};
  const setVoiceListener = listener => { listenInVoiceChannel = listener; };

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
    newChannel.send({
      content: `<@${member.id}> <@&${STAFF_ROLE_ID}>`,
      embeds: [{
        color: 0x5865f2,
        title: '🛡️ Verification session',
        description: `Salam ${member.displayName}! Daba ghadi yji staff yverifyiwk, stenna chwia hna 🙂\n\n**Staff:** 3afakom dkholou l-channel bach tverifyiw ${member.displayName}.`,
      }],
      allowedMentions: { users: [member.id], roles: [STAFF_ROLE_ID] },
    }).catch(() => {});
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
    { name: 'join_voice', description: 'Joins the voice channel the caller is currently in. Darija phrases like "bdkhol tap", "dkhol l tap", or "nta dkhol tap" mean join_voice; do not interpret them as a member rejection.', parameters: { type: 'OBJECT', properties: { channel: { type: 'STRING' } } } },
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

function getVoiceCommandIntent(text) {
  const input = String(text || '').toLowerCase().replace(/[.,!?]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!input || /^(how|how do i|how can i|kifach|wach n9der|chno ma3na)\b/.test(input)) return null;
  const hasChannel = /\b(tap|voice|room|channel)\b/.test(input);
  const lock = /\b(lock|close|tsad|tsedd|tssed|sedd|ssed|sdd|7bes)\b/.test(input);
  const unlock = /\b(open|unlock|7ol|7ell|7el|7oul|7oul|7oul|7ellih)\b/.test(input);

  if (hasChannel && lock) return { name: 'manage_current_channel', args: { action: 'lock', scope: 'voice' } };
  if (hasChannel && (unlock || (/\b(allow|let|khli|khalli)\b/.test(input) && /\b(join|dkhol|bdkhol|bdekhol|dkhal|bdkhal|dkhel|d5ol|d5al|d5el)\b/.test(input)))) {
    return { name: 'manage_current_channel', args: { action: 'unlock', scope: 'voice' } };
  }
  if (/\b(create|make|new|sweb|dir)\b/.test(input) && /\b(voice|room|channel)\b/.test(input)) {
    return { name: 'create_personal_voice_room', args: {} };
  }
  if (/\b(join|enter|dkhol|bdkhol|bdekhol|dkhal|bdkhal|dkhel|d5ol|d5al|d5el)\b/.test(input) && /\b(tap|voice|room|channel)\b/.test(input)) {
    return { name: 'join_voice', args: { channel: 'here' } };
  }
  if (/\b(rename|change name|bdel|bddel)\b/.test(input) && /\b(room|voice|smit|smiya)\b/.test(input)) {
    const match = input.match(/\b(?:to|as|smit|smiya)\s+(.+)$/);
    if (match?.[1]) return { name: 'rename_voice_room', args: { name: match[1].trim() } };
  }
  if (/\b(play|playi|shghl|chghl)\b/.test(input) && /\b(music|song|track|ghnya|music)\b/.test(input)) {
    const query = input.replace(/^.*?\b(?:music|song|track|ghnya)\b\s*/, '').trim();
    if (query) return { name: 'play_music', args: { query } };
  }
  if (/\b(skip|next|doz)\b/.test(input) && /\b(music|song|track|ghnya)\b/.test(input)) return { name: 'skip_music', args: {} };
  if (/\b(stop|wa9ef|w9ef)\b/.test(input) && /\b(music|song|track|ghnya)\b/.test(input)) return { name: 'stop_music', args: {} };
  if (/\b(leave|khrej|khrrej)\b/.test(input) && /\b(voice|music|room|channel)\b/.test(input)) return { name: 'leave_music', args: {} };
  return null;
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
  // In this bot's Darija commands, "tap" means the current voice channel.
  const hasVoiceScope = /\b(voice|room|tap)\b/.test(input);
  const hasTextScope = /\b(text|chat|text channel)\b/.test(input);
  if (!hasTextScope && isInTemporaryRoom && /\b(allow|let|khli|khalli)\b/.test(input)
    && /\b(join|dkhol|bdkhol|bdekhol|dkhal|bdkhal|dkhel|d5ol|d5al|d5el)\b/.test(input) && /\btap\b/.test(input)) {
    return { name: 'manage_current_channel', args: { action: 'unlock', scope: 'voice' } };
  }
  if (!hasTextScope && /\b(join|enter|dkhol|bdkhol|bdekhol|dkhal|bdkhal|dkhel|d5ol|d5al|d5el)\b/.test(input)
    && /\b(tap|voice|room|channel)\b/.test(input)) {
    return { name: 'join_voice', args: { channel: 'here' } };
  }
  if (/\b(create|make|new|sweb|dir)\b/.test(input) && /\b(voice|room)\b/.test(input)) {
    return { name: 'create_personal_voice_room', args: {} };
  }
  const lock = /\b(lock|close|tsad|tsedd|tssed|ssed|sedd|sdd|7bes)\b/.test(input);
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
    const messageVoiceChannel = message.channel?.isVoiceBased?.() ? message.channel : null;
    const ch = args.channel && !['here', 'me', 'my channel', 'hna'].includes(args.channel.toLowerCase().trim())
      ? findVoiceChannel(message.guild, args.channel)
      : caller.voice.channel || messageVoiceChannel;
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


  return { roomOwners, userAddressForms, discordTools, sendLog, startVerification, createPersonalVoiceRoom, findRole, findChannel, findVoiceChannel, findTargetMember, resolveMembers, extractResponseText, formatToolSummary, getVoiceCommandIntent, getDirectChannelIntent, explicitlyRequestedVoiceModeration, getAddressFormPreference, checkRoleManagementPermissions, canCallerModerate, canCallerMove, canManageChannels, isVoiceRoomOwner, canManageRoles, executeDiscordTool, setVoiceListener };
}

module.exports = { createDiscordService };
