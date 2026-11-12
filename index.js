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
let YtDlpPlugin = null;
let SoundCloudPlugin = null;

try { DisTube = require('distube').DisTube; } catch (e) { console.error(`[Music] Could not load DisTube: ${e.message}`); }
try { YtDlpPlugin = require('@distube/yt-dlp').YtDlpPlugin; } catch (e) { console.error(`[Music] Could not load yt-dlp plugin: ${e.message}`); }
try { SoundCloudPlugin = require('@distube/soundcloud').SoundCloudPlugin; } catch (e) { console.warn(`[Music] SoundCloud plugin unavailable: ${e.message}`); }

// Use default plugins so yt-dlp auto-updates its YouTube signatures (Fixes FFmpeg Code 1)
const plugins = [];
if (SoundCloudPlugin) plugins.push(new SoundCloudPlugin());
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

if (distube) {
  distube.on('playSong', (queue, song) => {
    if (queue && queue.textChannel) {
      queue.textChannel.send(`🎶 Daba kayn-playi: \`${song.name}\``).catch(() => {});
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

  distube.on('error', (error, queue) => {
    console.error('[Music] Full Error:', error);
    if (queue && queue.textChannel) {
      queue.textChannel.send(`❌ W9e3 error f l-music: \`${error.message}\``).catch(() => {});
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

const aiUserCooldowns = new Map();
const AI_COOLDOWN_MS = 2000;
const AI_MAX_QUESTION_CHARS = 1500;
const AI_MAX_CONTEXT_CHARS = 1200;
const AI_MAX_OUTPUT_TOKENS = 120;
const roomOwners = new Map();

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
      const customOverwrites = [
        { id: member.id, allow: [PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak, PermissionsBitField.Flags.SendMessages] },
        { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak, PermissionsBitField.Flags.ManageChannels] },
      ];
      if (NOT_VERIFIED_ROLE_ID) customOverwrites.push({ id: NOT_VERIFIED_ROLE_ID, deny: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect] });

      const customChannel = await newState.guild.channels.create({
        name: `🔊 ${member.displayName}'s Room`,
        type: ChannelType.GuildVoice,
        parent: (CREATE_CATEGORY_ID && CREATE_CATEGORY_ID.length > 5) ? CREATE_CATEGORY_ID : null,
        permissionOverwrites: customOverwrites,
      });

      roomOwners.set(customChannel.id, member.id);
      await member.voice.setChannel(customChannel);
      sendLog(newState.guild, `🎙️ **Room Created:** <@${member.id}> created a custom voice channel (\`${customChannel.name}\`).`).catch(() => {});
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
        case 'play_music': return `Safi bda kayn-playi \`${r.query}\` 🎶`;
        case 'skip_music': return `Safi skipt l-ghnya ⏭️`;
        case 'stop_music': return `Safi w9eft l-music ⏹️`;
        case 'leave_music': return `Safi kherrejt mn l voice 👋`;
        case 'delete_channel': return `Safi ms7t channel \`${r.name}\` 🗑️`;
        case 'delete_role': return `Safi ms7t role \`${r.name}\` 🗑️`;
        default: return `Safi t-dar l-action **${name}** ✅`;
      }
    }).join('\n');
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

function canManageRoles(caller) {
  return (STAFF_ROLE_ID && caller.roles.cache.has(STAFF_ROLE_ID)) || caller.permissions.has(PermissionsBitField.Flags.Administrator) || caller.permissions.has(PermissionsBitField.Flags.ManageRoles);
}

async function executeDiscordTool(name, args, message) {
  const caller = message.member;
  const noTargetTools = ['create_channel', 'create_role', 'move_all_members', 'move_members', 'dm_members', 'start_verification', 'join_voice', 'play_music', 'skip_music', 'stop_music', 'leave_music', 'delete_channel', 'delete_role'];

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
    if (!canCallerModerate(caller)) return { success: false, error: 'Ghir staff.' };
    if (targetMember.id === message.client.user.id) return { success: false, error: 'Ma ymkench t-muti l-bot.' };
    if (!targetMember.voice.channel) return { success: false, error: `${targetMember.displayName} ma dakhltch l voice.` };
    try { await targetMember.voice.setMute(true); return { success: true, user: targetMember.displayName, mention: `<@${targetMember.id}>` }; } catch (err) { return { success: false, error: err.message }; }
  }

  if (name === 'unmute_member') {
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
    try { await distube.voices.join(ch); return { success: true, channel: ch.name }; } catch (e) { return { success: false, error: e.message }; }
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

    const systemInstruction = `You are "kho Kokiee", a helpful, witty Discord bot.
Reply in casual Moroccan Darija (Darija written in Latin letters / Arabizi only; never use Arabic script). Keep answers very short (1-2 sentences).
Use provided Discord tools when asked. For regular chit-chat, just answer directly.`;

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

          result = await chat.sendMessage(finalPrompt);
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

      console.log(`[AI] Replying (${responseText.length} chars)`);
      await message.reply(responseText).catch(() => message.channel.send(responseText));
    } catch (err) {
      console.error(`Gemini API Error: ${err.message}`);
      aiUserCooldowns.delete(message.author.id);
      await message.reply('😅 Sme7 lia, w9e3 mochkil f ljawab. 3awed jereb mn b3d chwia.').catch(() => {});
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
