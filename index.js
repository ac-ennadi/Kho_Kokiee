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

// Music (optional): Separated try/catch blocks so one missing plugin doesn't break everything
let DisTube = null;
let YtDlpPlugin = null;
let SoundCloudPlugin = null;

try {
  DisTube = require('distube').DisTube;
} catch (e) {
  console.warn(`[Music] distube library not installed: ${e.message}`);
}

try {
  YtDlpPlugin = require('@distube/yt-dlp').YtDlpPlugin;
} catch (e) {
  console.warn(`[Music] @distube/yt-dlp not installed: ${e.message}`);
}

try {
  SoundCloudPlugin = require('@distube/soundcloud').SoundCloudPlugin;
} catch (e) {
  console.warn(`[Music] @distube/soundcloud not installed: ${e.message}`);
}

// Music playback setup (distube v5 + yt-dlp + soundcloud)
const plugins = [];
if (YtDlpPlugin) {
  plugins.push(new YtDlpPlugin({ update: true }));
}
if (SoundCloudPlugin) {
  plugins.push(new SoundCloudPlugin());
}

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

const distube = DisTube
  ? new DisTube(client, {
      plugins: plugins,
      emitNewSongOnly: true,
      ffmpeg: { path: ffmpegPathString || 'ffmpeg' },
    })
  : null;

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

// Configuration IDs loaded securely from Railway Environment Variables
const ROLE_ID = process.env.ROLE_ID;
const NOT_VERIFIED_ROLE_ID = process.env.NOT_VERIFIED_ROLE_ID;
const TARGET_VC_ID = process.env.TARGET_VC_ID;
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID;
const MOVE_ROLE_ID = process.env.MOVE_ROLE_ID;
const CATEGORY_ID = process.env.CATEGORY_ID || null;
const CREATE_VC_ID = process.env.CREATE_VC_ID;
const CREATE_CATEGORY_ID = process.env.CREATE_CATEGORY_ID || null;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || null;

// Google Gemini AI setup with automatic fallback models on 503/429 spikes
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
let activeGeminiModel = process.env.GEMINI_MODEL || null;
let availableModelsCache = [];
let genAI = null;
if (GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
}

async function fetchSupportedModels() {
  if (!GEMINI_API_KEY) return ['gemini-3.5-flash-lite'];
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`);
    if (res.ok) {
      const data = await res.json();
      const models = (data.models || [])
        .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
        .map(m => m.name.replace(/^models\//, ''));
      if (models.length > 0) {
        availableModelsCache = models;
        console.log('Available Gemini models for this key:', models);
        return models;
      }
    }
  } catch (e) {
    console.error(`Could not fetch model list: ${e.message}`);
  }
  return ['gemini-3.5-flash-lite'];
}

async function getModelCandidates() {
  if (availableModelsCache.length === 0) {
    await fetchSupportedModels();
  }
  const preferredOrder = [
    activeGeminiModel,
    'gemini-3.5-flash-lite',
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
    'gemini-3.8-flash',
    'gemini-2.0-flash',
    ...availableModelsCache.filter(m => m.toLowerCase().includes('flash')),
    ...availableModelsCache,
  ].filter(Boolean);

  return [...new Set(preferredOrder)].filter(
    m => availableModelsCache.length === 0 || availableModelsCache.includes(m)
  );
}

async function getAvailableGeminiModel() {
  if (activeGeminiModel) return activeGeminiModel;
  const candidates = await getModelCandidates();
  activeGeminiModel = candidates[0] || 'gemini-3.5-flash-lite';
  console.log(`🤖 Auto-selected Gemini model: ${activeGeminiModel}`);
  return activeGeminiModel;
}

const aiUserCooldowns = new Map();
const AI_COOLDOWN_MS = 4000;
const AI_MAX_QUESTION_CHARS = 1500;
const AI_MAX_OUTPUT_TOKENS = 800;

// In-memory tracker to remember who owns which custom voice channel { channelId: userId }
const roomOwners = new Map();

// Helper function to send logs to the designated log channel
async function sendLog(guild, messageText) {
  if (!LOG_CHANNEL_ID) return;
  try {
    const logChannel = guild.channels.cache.get(LOG_CHANNEL_ID) || await guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (logChannel && logChannel.isTextBased()) {
      await logChannel.send(messageText);
    }
  } catch (error) {
    console.error(`Failed to send log: ${error.message}`);
  }
}

// Start a verification session: private channel + ping staff + talk to the member
async function startVerification(guild, member) {
  if (!STAFF_ROLE_ID) {
    return { success: false, error: 'STAFF_ROLE_ID is not configured, so the bot cannot ping staff for verification.' };
  }
  try {
    const overwrites = [
      { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
      { id: member.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak] },
      {
        id: client.user.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.Connect,
          PermissionsBitField.Flags.Speak,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
          PermissionsBitField.Flags.ManageChannels,
        ],
      },
    ];

    const staffRole = guild.roles.cache.get(STAFF_ROLE_ID);
    if (staffRole) {
      overwrites.push({
        id: staffRole.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.Connect,
          PermissionsBitField.Flags.Speak,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
        ],
      });
    }

    const newChannel = await guild.channels.create({
      name: `verify-${member.displayName}`,
      type: ChannelType.GuildVoice,
      parent: (CATEGORY_ID && CATEGORY_ID.length > 5) ? CATEGORY_ID : null,
      permissionOverwrites: overwrites,
    });

    if (member.voice && member.voice.channelId) {
      await member.voice.setChannel(newChannel).catch(() => {});
    }

    try {
      await newChannel.send(`👋 Salam <@${member.id}>! Daba ghadi yjiw staff bach yverify-iwk. Stenna chwia hna 🙂`);
    } catch (e) {}

    try {
      await newChannel.send(`<@&${STAFF_ROLE_ID}> New verification session for **${member.displayName}**. Please come verify them here!`);
    } catch (e) {}

    try {
      await member.send(`👋 Salam ${member.displayName}! 3ayetna l staff bach yverify-iwk. Dkhol l <#${newChannel.id}> daba 🙂`);
    } catch (e) {}

    sendLog(guild, `🛡️ **Verification Session:** <@${member.id}> started a verification session in \`${newChannel.name}\`.`).catch(() => {});
    return { success: true, user: member.displayName, mention: `<@${member.id}>`, channel: newChannel.name };
  } catch (err) {
    return { success: false, error: `Failed to start verification: ${err.message}` };
  }
}

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}! Bot is online and ready.`);
  if (!GEMINI_API_KEY) {
    console.log('⚠️ GEMINI_API_KEY is missing. Mention-based AI replies will be disabled.');
  } else {
    const selectedModel = await getAvailableGeminiModel();
    console.log(`🤖 Gemini AI ready with model: ${selectedModel}`);
  }
});

// 1. Assign role when a new member joins the server
client.on('guildMemberAdd', async (member) => {
  try {
    const role = member.guild.roles.cache.get(ROLE_ID);
    if (!role) return;
    await member.roles.add(role);
    await sendLog(member.guild, `📥 **New Member:** Assigned the base role to <@${member.id}> (${member.user.tag}).`);
  } catch (error) {
    console.error(`Failed to assign role: ${error.message}`);
  }
});

// 2. Log Nickname Changes
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  if (oldMember.nickname !== newMember.nickname) {
    const oldName = oldMember.nickname || oldMember.user.username;
    const newName = newMember.nickname || newMember.user.username;

    let executorString = `<@${newMember.id}> (Self-changed)`;

    try {
      const fetchedLogs = await newMember.guild.fetchAuditLogs({
        limit: 1,
        type: AuditLogEvent.MemberUpdate,
      });
      const updateLog = fetchedLogs.entries.first();

      if (updateLog && updateLog.target.id === newMember.id && (Date.now() - updateLog.createdTimestamp < 3000)) {
        executorString = `<@${updateLog.executor.id}>`;
      }
    } catch (e) {}

    await sendLog(newMember.guild, `📝 **Nickname Change:** ${executorString} changed the nickname of <@${newMember.id}> from \`${oldName}\` to \`${newName}\`.`);
  }
});

// 3. Handle voice channel workflows, cleanup, and voice moderation logs
client.on('voiceStateUpdate', async (oldState, newState) => {
  // A. LOGGING VOICE MOVES
  if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
    let executorString = `<@${newState.member.id}> (Self-moved)`;

    try {
      const fetchedLogs = await newState.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.MemberMove });
      const moveLog = fetchedLogs.entries.first();

      if (moveLog && (Date.now() - moveLog.createdTimestamp < 3000)) {
        executorString = `<@${moveLog.executor.id}> (Moderator)`;
      }
    } catch (err) {}

    await sendLog(newState.guild, `🔀 **Voice Move:** ${executorString} moved <@${newState.member.id}> from \`${oldState.channel.name}\` to \`${newState.channel.name}\`.`);
  }

  // B. LOGGING SERVER MUTE AND DEAFEN
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

        if (updateLog && updateLog.target.id === newState.member.id && (Date.now() - updateLog.createdTimestamp < 3000)) {
          executorString = `<@${updateLog.executor.id}>`;
        }
      } catch (err) {}

      await sendLog(newState.guild, `🔇 **Voice Moderation:** ${executorString} ${action} <@${newState.member.id}>.`);
    }
  }

  // C. CLEANUP: Delete empty temporary rooms
  if (oldState.channel) {
    const channel = oldState.channel;
    const isVerifyChannel = channel.name.startsWith('verify-');
    const isCustomRoom = roomOwners.has(channel.id) || channel.name.startsWith('🔊 ') || channel.name.includes("'s Room");

    if ((isVerifyChannel || isCustomRoom) && channel.members.size === 0) {
      const botMember = channel.guild.members.me;
      const perms = channel.permissionsFor(botMember);
      const canManage = perms ? perms.has(PermissionsBitField.Flags.ManageChannels) : false;

      try {
        roomOwners.delete(channel.id);
        await channel.delete();
        await sendLog(channel.guild, `🗑️ **Room Deleted:** Auto-deleted empty temporary channel \`${channel.name}\`.`);
      } catch (err) {
        await sendLog(channel.guild, `⚠️ **Cleanup Failed:** \`${channel.name}\` — ${err.message} (bot has ManageChannels: ${canManage}).`).catch(() => {});
        setTimeout(async () => {
          try {
            const ch = channel.guild.channels.cache.get(channel.id);
            if (ch && ch.members.size === 0) {
              await ch.delete();
              await sendLog(channel.guild, `🗑️ **Room Deleted:** Auto-deleted empty temporary channel \`${ch.name}\`.`).catch(() => {});
            }
          } catch (e) {}
        }, 1500);
      }
    }
  }

  // D. JOIN TO CREATE: Custom member rooms
  if (CREATE_VC_ID && newState.channelId === CREATE_VC_ID && oldState.channelId !== CREATE_VC_ID) {
    const member = newState.member;
    try {
      const guild = newState.guild;
      const customOverwrites = [
        {
          id: member.id,
          allow: [
            PermissionsBitField.Flags.ManageChannels,
            PermissionsBitField.Flags.Connect,
            PermissionsBitField.Flags.Speak,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
          ],
        },
        {
          id: client.user.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.Connect,
            PermissionsBitField.Flags.Speak,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
            PermissionsBitField.Flags.ManageChannels,
          ],
        },
      ];

      if (NOT_VERIFIED_ROLE_ID) {
        customOverwrites.push({ id: NOT_VERIFIED_ROLE_ID, deny: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect] });
      }

      const customChannel = await guild.channels.create({
        name: `🔊 ${member.displayName}'s Room`,
        type: ChannelType.GuildVoice,
        parent: (CREATE_CATEGORY_ID && CREATE_CATEGORY_ID.length > 5) ? CREATE_CATEGORY_ID : null,
        permissionOverwrites: customOverwrites,
      });

      roomOwners.set(customChannel.id, member.id);
      await member.voice.setChannel(customChannel);
      await sendLog(guild, `🎙️ **Room Created:** <@${member.id}> created a custom voice channel (\`${customChannel.name}\`).`);

      setTimeout(async () => {
        try {
          await customChannel.send(
            `👋 Welcome to your custom room, <@${member.id}>!\n` +
            `Here are the commands you can use to control your channel:\n` +
            `• \`.a name <new name>\` - Rename your room\n` +
            `• \`.a lock\` - Lock your room so no one else can join\n` +
            `• \`.a unlock\` - Unlock your room\n` +
            `• \`.a limit <number>\` - Set a max user limit (0 for unlimited)\n` +
            `• \`.a add @User\` (or \`.a permit @User\`) - Allow a specific user to join\n` +
            `• \`.a reject @User\` - Block and kick a user from your room\n` +
            `• \`.a claim\` - Reclaim ownership if the bot restarts`
          );
        } catch (err) {}
      }, 1000);
    } catch (error) {}
  }

  // E. VERIFICATION WORKFLOW
  if (TARGET_VC_ID && newState.channelId === TARGET_VC_ID && oldState.channelId !== TARGET_VC_ID) {
    const member = newState.member;
    if (NOT_VERIFIED_ROLE_ID && !member.roles.cache.has(NOT_VERIFIED_ROLE_ID)) return;
    await startVerification(newState.guild, member);
  }
});

// ==========================================
// AI MODERATION & VOICE TOOLS DEFINITION
// ==========================================
const discordTools = [
  {
    functionDeclarations: [
      {
        name: 'give_role',
        description: 'Assigns/gives a Discord server role to a user.',
        parameters: {
          type: 'OBJECT',
          properties: {
            target_user: { type: 'STRING', description: 'The username, display name, mention, or user ID of the person to receive the role' },
            role_name: { type: 'STRING', description: 'The name or mention of the role to assign' },
          },
          required: ['target_user', 'role_name'],
        },
      },
      {
        name: 'remove_role',
        description: 'Removes/takes away a Discord server role from a user.',
        parameters: {
          type: 'OBJECT',
          properties: {
            target_user: { type: 'STRING', description: 'The username, display name, mention, or user ID of the person' },
            role_name: { type: 'STRING', description: 'The name or mention of the role to remove' },
          },
          required: ['target_user', 'role_name'],
        },
      },
      {
        name: 'mute_member',
        description: "Mutes a member's microphone in their voice channel.",
        parameters: {
          type: 'OBJECT',
          properties: {
            target_user: { type: 'STRING', description: 'The username, display name, mention, or user ID of the person to voice-mute' },
            reason: { type: 'STRING', description: 'Optional reason for voice muting' },
          },
          required: ['target_user'],
        },
      },
      {
        name: 'unmute_member',
        description: 'Unmutes a member in voice channel and removes server timeout.',
        parameters: {
          type: 'OBJECT',
          properties: {
            target_user: { type: 'STRING', description: 'The username, display name, mention, or user ID of the person to unmute' },
          },
          required: ['target_user'],
        },
      },
      {
        name: 'move_member',
        description: 'Pulls/moves a user from their voice channel into the caller current voice channel or a specified channel.',
        parameters: {
          type: 'OBJECT',
          properties: {
            target_user: { type: 'STRING', description: 'The username, display name, mention, or user ID of the person to move' },
            destination: { type: 'STRING', description: 'Optional channel name or ID to move them to' },
          },
          required: ['target_user'],
        },
      },
      {
        name: 'disconnect_member',
        description: 'Kicks or disconnects a user from their current voice channel.',
        parameters: {
          type: 'OBJECT',
          properties: {
            target_user: { type: 'STRING', description: 'The username, display name, mention, or user ID of the person to disconnect' },
            reason: { type: 'STRING', description: 'Optional reason for disconnecting' },
          },
          required: ['target_user'],
        },
      },
      {
        name: 'deafen_member',
        description: 'Server-deafens a user in voice channel so they cannot hear anything.',
        parameters: {
          type: 'OBJECT',
          properties: {
            target_user: { type: 'STRING', description: 'The username, display name, mention, or user ID of the person to deafen' },
          },
          required: ['target_user'],
        },
      },
      {
        name: 'undeafen_member',
        description: 'Removes server deafen from a user in voice channel.',
        parameters: {
          type: 'OBJECT',
          properties: {
            target_user: { type: 'STRING', description: 'The username, display name, mention, or user ID of the person to undeafen' },
          },
          required: ['target_user'],
        },
      },
      {
        name: 'create_channel',
        description: 'Creates a new text or voice channel in the server.',
        parameters: {
          type: 'OBJECT',
          properties: {
            name: { type: 'STRING', description: 'The name of the new channel' },
            type: { type: 'STRING', description: 'The channel type: "text" or "voice"' },
            category: { type: 'STRING', description: 'Optional category name or ID' },
          },
          required: ['name'],
        },
      },
      {
        name: 'create_role',
        description: 'Creates a new server role.',
        parameters: {
          type: 'OBJECT',
          properties: {
            name: { type: 'STRING', description: 'The name of the new role' },
            color: { type: 'STRING', description: 'Optional hex color like "#FF0000"' },
          },
          required: ['name'],
        },
      },
      {
        name: 'move_all_members',
        description: 'Moves EVERY member currently in a source voice channel into a destination voice channel.',
        parameters: {
          type: 'OBJECT',
          properties: {
            source_channel: { type: 'STRING', description: 'Name or ID of the source voice channel' },
            destination_channel: { type: 'STRING', description: 'Name or ID of the destination voice channel' },
          },
          required: ['destination_channel'],
        },
      },
      {
        name: 'move_members',
        description: 'Moves several specific members into a voice channel.',
        parameters: {
          type: 'OBJECT',
          properties: {
            target_users: { type: 'STRING', description: 'Comma-separated list of usernames, mentions, or user IDs' },
            destination: { type: 'STRING', description: 'Optional destination channel name or ID' },
          },
          required: ['target_users'],
        },
      },
      {
        name: 'dm_members',
        description: 'Sends a private direct message (DM) to one or multiple members.',
        parameters: {
          type: 'OBJECT',
          properties: {
            target_users: { type: 'STRING', description: 'Comma-separated list of usernames, mentions, or user IDs' },
            message_text: { type: 'STRING', description: 'The private message text to send' },
          },
          required: ['target_users', 'message_text'],
        },
      },
      {
        name: 'start_verification',
        description: 'Starts a verification session: creates a private verify channel and pings staff.',
        parameters: {
          type: 'OBJECT',
          properties: {
            target_user: { type: 'STRING', description: 'Optional username, mention, or user ID of the person to verify' },
          },
          required: [],
        },
      },
      {
        name: 'join_voice',
        description: 'Joins the caller voice channel.',
        parameters: {
          type: 'OBJECT',
          properties: {
            channel: { type: 'STRING', description: 'Optional voice channel name or ID to join' },
          },
          required: [],
        },
      },
      {
        name: 'play_music',
        description: 'Plays a song in the caller voice channel.',
        parameters: {
          type: 'OBJECT',
          properties: {
            query: { type: 'STRING', description: 'The song name, artist, or link to play' },
          },
          required: ['query'],
        },
      },
      {
        name: 'skip_music',
        description: 'Skips the current song.',
        parameters: { type: 'OBJECT', properties: {}, required: [] },
      },
      {
        name: 'stop_music',
        description: 'Stops the music and clears the queue.',
        parameters: { type: 'OBJECT', properties: {}, required: [] },
      },
      {
        name: 'leave_music',
        description: 'Stops the music and leaves the voice channel.',
        parameters: { type: 'OBJECT', properties: {}, required: [] },
      },
      {
        name: 'delete_channel',
        description: 'Deletes a text or voice channel.',
        parameters: {
          type: 'OBJECT',
          properties: {
            channel_name: { type: 'STRING', description: 'The name, mention, or ID of the channel to delete' },
          },
          required: ['channel_name'],
        },
      },
      {
        name: 'delete_role',
        description: 'Deletes a server role.',
        parameters: {
          type: 'OBJECT',
          properties: {
            role_name: { type: 'STRING', description: 'The name, mention, or ID of the role to delete' },
          },
          required: ['role_name'],
        },
      },
    ],
  },
];

function findRole(guild, roleQuery) {
  if (!roleQuery) return null;
  const clean = roleQuery.replace(/^[<@&>#\s]+/, '').replace(/[>\s]+$/, '').trim().toLowerCase();
  if (/^\d{17,20}$/.test(clean)) {
    const role = guild.roles.cache.get(clean);
    if (role) return role;
  }
  return guild.roles.cache.find(r => r.name.toLowerCase() === clean)
    || guild.roles.cache.find(r => r.name.toLowerCase().includes(clean))
    || null;
}

function findChannel(guild, query, type) {
  if (!query) return null;
  const clean = query.replace(/^[<#>#\s]+/, '').replace(/[>\s]+$/, '').trim().toLowerCase();
  if (/^\d{17,20}$/.test(clean)) {
    const ch = guild.channels.cache.get(clean);
    if (ch) return ch;
  }
  const filterType = (ch) => {
    if (type === 'category' && ch.type !== ChannelType.GuildCategory) return false;
    if (type === 'voice' && !ch.isVoiceBased()) return false;
    if (type === 'text' && !ch.isTextBased()) return false;
    return true;
  };
  return guild.channels.cache.find(ch => filterType(ch) && ch.name.toLowerCase() === clean)
    || guild.channels.cache.find(ch => filterType(ch) && ch.name.toLowerCase().includes(clean))
    || null;
}

function findVoiceChannel(guild, query) {
  return findChannel(guild, query, 'voice');
}

async function resolveMembers(guild, targetUsers, mentions, botId) {
  const found = new Map();
  if (mentions && mentions.members && mentions.members.size > 0) {
    for (const m of mentions.members.values()) {
      if (m.id !== botId) found.set(m.id, m);
    }
  }
  if (targetUsers) {
    const parts = String(targetUsers).split(/[,\u060C\n]+/).map(s => s.trim()).filter(Boolean);
    for (const part of parts) {
      const m = await findTargetMember(guild, part, null, botId);
      if (m) found.set(m.id, m);
    }
  }
  return Array.from(found.values());
}

function extractResponseText(response) {
  if (!response) return '';
  try {
    const text = response.text();
    if (text && text.trim()) return text.trim();
  } catch (e) {}
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
    })
    .join('\n');
}

function checkRoleManagementPermissions(caller, role, guild) {
  const isOwner = guild.ownerId === caller.id;
  const isAdmin = caller.permissions.has(PermissionsBitField.Flags.Administrator);
  const canManageRoles = caller.permissions.has(PermissionsBitField.Flags.ManageRoles);
  const hasStaffRole = STAFF_ROLE_ID && caller.roles.cache.has(STAFF_ROLE_ID);

  if (!isOwner && !isAdmin && !canManageRoles && !hasStaffRole) {
    return {
      allowed: false,
      error: `Permission denied: ${caller.displayName} does not have permission to manage roles.`,
    };
  }

  const botMember = guild.members.me;
  if (role.position >= botMember.roles.highest.position) {
    return {
      allowed: false,
      error: `Cannot manage "${role.name}" because it is higher than or equal to my bot role.`,
    };
  }

  if (!isOwner && role.position >= caller.roles.highest.position) {
    return {
      allowed: false,
      error: `Permission denied: "${role.name}" is equal to or higher than your own highest role.`,
    };
  }

  if (role.managed) {
    return {
      allowed: false,
      error: `Cannot manage "${role.name}" because it is managed by an integration.`,
    };
  }

  return { allowed: true };
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
    try {
      const byId = await guild.members.fetch(idMatch[0]);
      if (byId) return byId;
    } catch (e) {}
  }

  const cleanName = query.replace(/^[@🔊\s]+/, '').toLowerCase().trim();
  if (!cleanName) return null;

  const cachedMember = guild.members.cache.find(
    m => m.user.username.toLowerCase().includes(cleanName) || m.displayName.toLowerCase().includes(cleanName)
  );
  if (cachedMember) return cachedMember;

  try {
    const searched = await guild.members.fetch({ query: cleanName, limit: 5 });
    if (searched && searched.size > 0) return searched.first();
  } catch (e) {}

  return null;
}

function canCallerModerate(caller) {
  const hasStaffRole = STAFF_ROLE_ID && caller.roles.cache.has(STAFF_ROLE_ID);
  const isAdmin = caller.permissions.has(PermissionsBitField.Flags.Administrator);
  const canMute = caller.permissions.has(PermissionsBitField.Flags.MuteMembers);
  const canModerate = caller.permissions.has(PermissionsBitField.Flags.ModerateMembers);
  return hasStaffRole || isAdmin || canMute || canModerate;
}

function canCallerMove(caller) {
  const hasMoveRole = MOVE_ROLE_ID && caller.roles.cache.has(MOVE_ROLE_ID);
  const hasStaffRole = STAFF_ROLE_ID && caller.roles.cache.has(STAFF_ROLE_ID);
  const isAdmin = caller.permissions.has(PermissionsBitField.Flags.Administrator);
  const canMove = caller.permissions.has(PermissionsBitField.Flags.MoveMembers);
  return hasMoveRole || hasStaffRole || isAdmin || canMove;
}

async function executeDiscordTool(name, args, message) {
  const caller = message.member;

  const noTargetTools = [
    'create_channel', 'create_role', 'move_all_members', 'move_members',
    'dm_members', 'start_verification', 'join_voice', 'play_music',
    'skip_music', 'stop_music', 'leave_music', 'delete_channel', 'delete_role',
  ];

  let targetMember = null;
  if (!noTargetTools.includes(name)) {
    targetMember = await findTargetMember(message.guild, args.target_user, message.mentions, message.client.user.id);
    if (!targetMember) {
      return {
        success: false,
        error: `Ma lqitch chi member b smit "${args.target_user}". Tagi-h b @Username.`,
      };
    }
  }

  if (name === 'give_role') {
    const role = findRole(message.guild, args.role_name);
    if (!role) return { success: false, error: `Role "${args.role_name}" ma kaynch f server.` };
    const check = checkRoleManagementPermissions(caller, role, message.guild);
    if (!check.allowed) return { success: false, error: check.error };
    try {
      await targetMember.roles.add(role);
      sendLog(message.guild, `🛡️ **AI Role Grant:** <@${caller.id}> gave \`${role.name}\` to <@${targetMember.id}>.`).catch(() => {});
      return { success: true, user: targetMember.displayName, mention: `<@${targetMember.id}>`, role: role.name };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  if (name === 'remove_role') {
    const role = findRole(message.guild, args.role_name);
    if (!role) return { success: false, error: `Role "${args.role_name}" ma kaynch f server.` };
    if (ROLE_ID && role.id === ROLE_ID) return { success: false, error: 'Ma ymkench t-7eyed role l-asasi.' };
    const check = checkRoleManagementPermissions(caller, role, message.guild);
    if (!check.allowed) return { success: false, error: check.error };
    try {
      await targetMember.roles.remove(role);
      sendLog(message.guild, `🛡️ **AI Role Remove:** <@${caller.id}> removed \`${role.name}\` from <@${targetMember.id}>.`).catch(() => {});
      return { success: true, user: targetMember.displayName, mention: `<@${targetMember.id}>`, role: role.name };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  if (name === 'mute_member') {
    if (!canCallerModerate(caller)) return { success: false, error: 'Ghir staff li 3ndhom l-7a9 y-mutiw.' };
    if (targetMember.id === message.client.user.id) return { success: false, error: 'Ma ymkench t-muti l-bot.' };
    if (targetMember.permissions.has(PermissionsBitField.Flags.Administrator)) return { success: false, error: 'Ma ymkench t-muti Admin.' };
    if (!targetMember.voice.channel) return { success: false, error: `${targetMember.displayName} ma dakhltch l voice channel.` };
    try {
      await targetMember.voice.setMute(true, args.reason || `Muted via AI by ${caller.displayName}`);
      sendLog(message.guild, `🔇 **AI Voice Mute:** <@${caller.id}> muted <@${targetMember.id}>.`).catch(() => {});
      return { success: true, user: targetMember.displayName, mention: `<@${targetMember.id}>`, channel: targetMember.voice.channel.name };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  if (name === 'unmute_member') {
    if (!canCallerModerate(caller)) return { success: false, error: 'Ghir staff li 3ndhom l-7a9 y-unmutiw.' };
    try {
      if (targetMember.voice.channel) await targetMember.voice.setMute(false, `Unmuted via AI by ${caller.displayName}`);
      if (targetMember.isCommunicationDisabled()) await targetMember.timeout(null, `Unmuted via AI by ${caller.displayName}`);
      sendLog(message.guild, `🔊 **AI Unmute:** <@${caller.id}> unmuted <@${targetMember.id}>.`).catch(() => {});
      return { success: true, user: targetMember.displayName, mention: `<@${targetMember.id}>` };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  if (name === 'move_member') {
    if (!canCallerMove(caller)) return { success: false, error: 'Ma 3ndekch permission bach t-7rek members.' };
    if (!targetMember.voice.channel) return { success: false, error: `${targetMember.displayName} ma dakhltch l voice.` };
    let destinationChannel = caller.voice.channel;
    if (args.destination && !['me', 'here', 'hna'].includes(args.destination.toLowerCase())) {
      const found = findVoiceChannel(message.guild, args.destination);
      if (found) destinationChannel = found;
    }
    if (!destinationChannel) return { success: false, error: 'Khassek tkon f voice channel bach njiboh 3ndek.' };
    try {
      await targetMember.voice.setChannel(destinationChannel);
      sendLog(message.guild, `🧲 **AI Move:** <@${caller.id}> moved <@${targetMember.id}> to \`${destinationChannel.name}\`.`).catch(() => {});
      return { success: true, user: targetMember.displayName, channel: destinationChannel.name, mention: `<@${targetMember.id}>` };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  if (name === 'disconnect_member') {
    if (!canCallerMove(caller)) return { success: false, error: 'Ma 3ndekch permission.' };
    if (!targetMember.voice.channel) return { success: false, error: `${targetMember.displayName} ma dakhltch l voice.` };
    try {
      await targetMember.voice.disconnect(args.reason || `Disconnected via AI by ${caller.displayName}`);
      sendLog(message.guild, `🚪 **AI Voice Kick:** <@${caller.id}> disconnected <@${targetMember.id}>.`).catch(() => {});
      return { success: true, user: targetMember.displayName, mention: `<@${targetMember.id}>` };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  if (name === 'deafen_member') {
    const canDeaf = caller.permissions.has(PermissionsBitField.Flags.DeafenMembers);
    if (!canCallerModerate(caller) && !canDeaf) return { success: false, error: 'Ma 3ndekch permission.' };
    if (!targetMember.voice.channel) return { success: false, error: `${targetMember.displayName} ma dakhltch l voice.` };
    try {
      await targetMember.voice.setDeaf(true, `Deafened via AI by ${caller.displayName}`);
      sendLog(message.guild, `🔇 **AI Deafen:** <@${caller.id}> deafened <@${targetMember.id}>.`).catch(() => {});
      return { success: true, user: targetMember.displayName, mention: `<@${targetMember.id}>` };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  if (name === 'undeafen_member') {
    const canDeaf = caller.permissions.has(PermissionsBitField.Flags.DeafenMembers);
    if (!canCallerModerate(caller) && !canDeaf) return { success: false, error: 'Ma 3ndekch permission.' };
    if (!targetMember.voice.channel) return { success: false, error: `${targetMember.displayName} ma dakhltch l voice.` };
    try {
      await targetMember.voice.setDeaf(false, `Undeafened via AI by ${caller.displayName}`);
      sendLog(message.guild, `🔊 **AI Undeafen:** <@${caller.id}> undeafened <@${targetMember.id}>.`).catch(() => {});
      return { success: true, user: targetMember.displayName, mention: `<@${targetMember.id}>` };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  if (name === 'create_channel') {
    const isOwner = message.guild.ownerId === caller.id;
    const isAdmin = caller.permissions.has(PermissionsBitField.Flags.Administrator);
    const canManageChannels = caller.permissions.has(PermissionsBitField.Flags.ManageChannels);
    const hasStaffRole = STAFF_ROLE_ID && caller.roles.cache.has(STAFF_ROLE_ID);
    if (!isOwner && !isAdmin && !canManageChannels && !hasStaffRole) {
      return { success: false, error: 'Ghir staff/admins li yqdro y-creatiw channels.' };
    }
    const channelName = (args.name || '').trim();
    if (!channelName) return { success: false, error: 'Smit channel darori.' };
    const typeRaw = (args.type || 'text').toLowerCase();
    const isVoice = typeRaw === 'voice' || typeRaw === 'vocal' || typeRaw === 'vc';
    let parentId = null;
    if (args.category) {
      const cat = findChannel(message.guild, args.category, 'category');
      if (cat) parentId = cat.id;
    }
    try {
      const newChannel = await message.guild.channels.create({
        name: channelName,
        type: isVoice ? ChannelType.GuildVoice : ChannelType.GuildText,
        ...(parentId ? { parent: parentId } : {}),
      });
      sendLog(message.guild, `➕ **AI Channel Created:** <@${caller.id}> created \`${newChannel.name}\`.`).catch(() => {});
      return { success: true, name: newChannel.name, mention: `<#${newChannel.id}>`, type: isVoice ? 'voice' : 'text' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  if (name === 'create_role') {
    const isOwner = message.guild.ownerId === caller.id;
    const isAdmin = caller.permissions.has(PermissionsBitField.Flags.Administrator);
    const canManageRoles = caller.permissions.has(PermissionsBitField.Flags.ManageRoles);
    const hasStaffRole = STAFF_ROLE_ID && caller.roles.cache.has(STAFF_ROLE_ID);
    if (!isOwner && !isAdmin && !canManageRoles && !hasStaffRole) {
      return { success: false, error: 'Ghir staff/admins li yqdro y-creatiw roles.' };
    }
    const roleName = (args.name || '').trim();
    if (!roleName) return { success: false, error: 'Smit role darori.' };
    const hex = (args.color || '').replace(/^#/, '').toUpperCase();
    const roleData = { name: roleName };
    if (/^[0-9A-F]{6}$/.test(hex)) roleData.color = hex;
    try {
      const role = await message.guild.roles.create(roleData);
      sendLog(message.guild, `➕ **AI Role Created:** <@${caller.id}> created role \`${role.name}\`.`).catch(() => {});
      return { success: true, name: role.name, mention: `<@&${role.id}>` };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  if (name === 'move_all_members') {
    if (!canCallerMove(caller)) return { success: false, error: 'Ma 3ndekch permission.' };
    const callerVoice = caller.voice.channel;
    const hereKeywords = ['here', 'me', 'my channel', 'my voice', 'hna', 'l hna', 'hadi', 'my vc'];
    let source = callerVoice;
    if (args.source_channel && !hereKeywords.includes(args.source_channel.toLowerCase().trim())) {
      source = findVoiceChannel(message.guild, args.source_channel);
    }
    let destination = callerVoice;
    if (args.destination_channel && !hereKeywords.includes(args.destination_channel.toLowerCase().trim())) {
      const found = findVoiceChannel(message.guild, args.destination_channel);
      if (found) destination = found;
    }
    if (!source || !destination || source.id === destination.id) {
      return { success: false, error: 'Ma lqitch source aw destination voice channel.' };
    }
    const members = Array.from(source.members.values());
    if (members.length === 0) return { success: false, error: `Ma kayn 7ed f "${source.name}".` };
    let moved = 0;
    for (const m of members) {
      try { await m.voice.setChannel(destination); moved++; } catch (e) {}
    }
    sendLog(message.guild, `🧲 **AI Bulk Move:** <@${caller.id}> moved ${moved} member(s) from \`${source.name}\` to \`${destination.name}\`.`).catch(() => {});
    return { success: true, moved, source: source.name, dest: destination.name };
  }

  if (name === 'move_members') {
    if (!canCallerMove(caller)) return { success: false, error: 'Ma 3ndekch permission.' };
    const members = await resolveMembers(message.guild, args.target_users, message.mentions, message.client.user.id);
    if (members.length === 0) return { success: false, error: 'Ma lqitch had members.' };
    let destination = caller.voice.channel;
    if (args.destination && !['here', 'me', 'my channel', 'my voice', 'hna'].includes(args.destination.toLowerCase().trim())) {
      const found = findVoiceChannel(message.guild, args.destination);
      if (found) destination = found;
    }
    if (!destination) return { success: false, error: 'Khassek tkon f voice channel.' };
    let moved = 0;
    for (const m of members) {
      try { await m.voice.setChannel(destination); moved++; } catch (e) {}
    }
    sendLog(message.guild, `🧲 **AI Bulk Move:** <@${caller.id}> moved ${moved} member(s) into \`${destination.name}\`.`).catch(() => {});
    return { success: true, moved, dest: destination.name };
  }

  if (name === 'dm_members') {
    const isOwner = message.guild.ownerId === caller.id;
    const isAdmin = caller.permissions.has(PermissionsBitField.Flags.Administrator);
    const hasStaffRole = STAFF_ROLE_ID && caller.roles.cache.has(STAFF_ROLE_ID);
    if (!isOwner && !isAdmin && !hasStaffRole) return { success: false, error: 'Ghir staff/admins li yqdro ysifto DM.' };
    const messageText = (args.message_text || '').trim();
    if (!messageText) return { success: false, error: 'Kteb message.' };
    const members = await resolveMembers(message.guild, args.target_users, message.mentions, message.client.user.id);
    if (members.length === 0) return { success: false, error: 'Ma lqitch had members.' };
    let sent = 0;
    for (const m of members) {
      try { await m.send(messageText); sent++; } catch (e) {}
    }
    sendLog(message.guild, `📩 **AI DM:** <@${caller.id}> sent DM to ${sent} member(s).`).catch(() => {});
    return { success: true, sent };
  }

  if (name === 'start_verification') {
    let target = caller;
    if (args.target_user && args.target_user.trim()) {
      const isOwner = message.guild.ownerId === caller.id;
      const isAdmin = caller.permissions.has(PermissionsBitField.Flags.Administrator);
      const hasStaffRole = STAFF_ROLE_ID && caller.roles.cache.has(STAFF_ROLE_ID);
      if (!isOwner && !isAdmin && !hasStaffRole) return { success: false, error: 'Tqder t-verifyi ghir rasek.' };
      target = await findTargetMember(message.guild, args.target_user, message.mentions, message.client.user.id);
      if (!target) return { success: false, error: `Ma lqitch "${args.target_user}".` };
    }
    return await startVerification(message.guild, target);
  }

  if (name === 'join_voice') {
    if (!distube) return { success: false, error: 'Music dependencies missing.' };
    let channel = caller.voice.channel;
    if (args.channel && !['here', 'me', 'my channel', 'my voice', 'hna'].includes(args.channel.toLowerCase().trim())) {
      const found = findVoiceChannel(message.guild, args.channel);
      if (found) channel = found;
    }
    if (!channel) return { success: false, error: 'Dkhol l voice channel b3da.' };
    try {
      await distube.voices.join(channel);
      return { success: true, channel: channel.name };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  if (name === 'play_music') {
    const query = (args.query || '').trim();
    if (!query) return { success: false, error: 'Kteb smit l-ghnya.' };
    if (!distube) return { success: false, error: 'Music dependencies missing.' };
    const targetChannel = caller.voice.channel || message.guild.members.me.voice.channel;
    if (!targetChannel) return { success: false, error: 'Dkhol l voice channel b3da.' };
    try {
      await distube.play(targetChannel, query, { member: caller, textChannel: message.channel, message });
      return { success: true, query };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  if (name === 'skip_music') {
    if (!distube) return { success: false, error: 'Music dependencies missing.' };
    try {
      const q = distube.getQueue(message.guild);
      if (!q) return { success: false, error: 'Ma kaynch chi music khdama.' };
      await q.skip();
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  if (name === 'stop_music') {
    if (!distube) return { success: false, error: 'Music dependencies missing.' };
    try {
      const q = distube.getQueue(message.guild);
      if (!q) return { success: false, error: 'Ma kaynch chi music khdama.' };
      q.stop();
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  if (name === 'leave_music') {
    if (!distube) return { success: false, error: 'Music dependencies missing.' };
    try {
      const q = distube.getQueue(message.guild);
      if (q) q.stop();
      await distube.voices.leave(message.guild);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  if (name === 'delete_channel') {
    const isOwner = message.guild.ownerId === caller.id;
    const isAdmin = caller.permissions.has(PermissionsBitField.Flags.Administrator);
    const canManageChannels = caller.permissions.has(PermissionsBitField.Flags.ManageChannels);
    const hasStaffRole = STAFF_ROLE_ID && caller.roles.cache.has(STAFF_ROLE_ID);
    if (!isOwner && !isAdmin && !canManageChannels && !hasStaffRole) return { success: false, error: 'Ma 3ndekch permission.' };
    const target = findChannel(message.guild, args.channel_name);
    if (!target) return { success: false, error: `Channel "${args.channel_name}" ma kaynch.` };
    try {
      const chName = target.name;
      await target.delete();
      sendLog(message.guild, `🗑️ **AI Channel Deleted:** <@${caller.id}> deleted \`${chName}\`.`).catch(() => {});
      return { success: true, name: chName };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  if (name === 'delete_role') {
    const isOwner = message.guild.ownerId === caller.id;
    const isAdmin = caller.permissions.has(PermissionsBitField.Flags.Administrator);
    const canManageRoles = caller.permissions.has(PermissionsBitField.Flags.ManageRoles);
    const hasStaffRole = STAFF_ROLE_ID && caller.roles.cache.has(STAFF_ROLE_ID);
    if (!isOwner && !isAdmin && !canManageRoles && !hasStaffRole) return { success: false, error: 'Ma 3ndekch permission.' };
    const role = findRole(message.guild, args.role_name);
    if (!role) return { success: false, error: `Role "${args.role_name}" ma kaynch.` };
    if (ROLE_ID && role.id === ROLE_ID) return { success: false, error: 'Ma ymkench t-ms7 role l-asasi.' };
    const check = checkRoleManagementPermissions(caller, role, message.guild);
    if (!check.allowed) return { success: false, error: check.error };
    try {
      const roleName = role.name;
      await role.delete();
      sendLog(message.guild, `🗑️ **AI Role Deleted:** <@${caller.id}> deleted role \`${roleName}\`.`).catch(() => {});
      return { success: true, name: roleName };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  return { success: false, error: `Unknown action: ${name}` };
}

// 4. Handle Messages & Commands
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  const botMention = client.user ? new RegExp(`<@!?${client.user.id}>`, 'g') : null;
  const isMentioned = botMention ? botMention.test(message.content) : false;

  let isReplyToBot = false;
  let referencedMessage = null;

  if (message.reference && message.reference.messageId) {
    referencedMessage = message.channel.messages.cache.get(message.reference.messageId)
      || await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
    if (referencedMessage && referencedMessage.author.id === client.user.id) {
      isReplyToBot = true;
    }
  }

  if (isMentioned || isReplyToBot) {
    if (!genAI) return message.reply('Sme7 lia, AI mazal ma tf3elatch.');

    const promptText = (botMention ? message.content.replace(botMention, '') : message.content).trim();
    if (!promptText) return message.reply('Ach bghiti tswelni? Kteb sou2al 🙂');
    if (promptText.length > AI_MAX_QUESTION_CHARS) {
      return message.reply(`Sou2al twil bzaf 😅 7awel tkhtasro l ${AI_MAX_QUESTION_CHARS} 7arf.`);
    }

    const now = Date.now();
    const lastRequest = aiUserCooldowns.get(message.author.id) || 0;
    if (now - lastRequest < AI_COOLDOWN_MS) return message.reply('3tini ghir chwia w nrje3 njawbek 🙂');
    aiUserCooldowns.set(message.author.id, now);

    // Show typing immediately without blocking
    message.channel.sendTyping().catch(() => {});

    // Read channel context from in-memory cache first for speed
    let channelContext = '';
    const cachedMsgs = Array.from(message.channel.messages.cache.values())
      .filter(m => m.id !== message.id && (!m.author.bot || m.author.id === client.user.id))
      .filter(m => (Date.now() - m.createdTimestamp) < 30 * 60 * 1000)
      .slice(-8);

    if (cachedMsgs.length > 0) {
      channelContext = cachedMsgs
        .map(m => {
          const sender = m.author.id === client.user.id ? 'kho Kokiee (Bot)' : (m.member?.displayName || m.author.username);
          const cleanContent = botMention ? m.content.replace(botMention, '').trim() : m.content.trim();
          return `[${sender}]: ${cleanContent}`;
        })
        .filter(line => line.trim().length > 0)
        .join('\n');
    }

    const chatHistory = [];
    if (referencedMessage && referencedMessage.content) {
      chatHistory.push({ role: 'user', parts: [{ text: 'Question: salam' }] });
      chatHistory.push({ role: 'model', parts: [{ text: referencedMessage.content.trim() }] });
    }

    const callerName = message.member?.displayName || message.author.username;
    const finalPrompt = channelContext
      ? `Recent channel conversation:\n${channelContext}\n\nCurrent message from [${callerName}]:\n${promptText}`
      : `[${callerName}]: ${promptText}`;

    const systemInstruction = `You are "kho Kokiee", a helpful, witty, and powerful Discord community assistant bot.
Reply in casual Moroccan Darija written with Latin letters (Arabizi like "salam cv", "labas", "chno", "sketto", "jbedto"). Never use Arabic script. Keep answers short, 1-2 sentences.
Use the provided Discord tools whenever the user asks for moderation, voice, roles, channels, verification, DMs, or music actions. For regular chit-chat, answer directly in Moroccan Darija.`;

    try {
      const candidates = await getModelCandidates();
      let result = null;
      let usedModel = candidates[0] || 'gemini-3.5-flash-lite';
      let chat = null;

      // Retry with fallback models if primary model returns 503 (high demand) or 429
      for (const candidate of candidates.slice(0, 4)) {
        try {
          usedModel = candidate;
          console.log(`[AI] Processing query from ${callerName} (${message.author.tag}): "${promptText}" using ${usedModel}`);
          const model = genAI.getGenerativeModel({
            model: usedModel,
            systemInstruction,
            tools: discordTools,
          });

          // Dynamically set thinking level based on what the specific model supports
          let thinkingLevel = undefined;
          if (usedModel.includes('3.5-flash-lite') || usedModel.includes('2.5-flash-lite')) {
            thinkingLevel = 'minimal';
          } else if (usedModel.includes('3.8') || usedModel.includes('2.0-flash')) {
            thinkingLevel = 'low';
          }

          chat = model.startChat({
            history: chatHistory.length > 0 ? chatHistory : undefined,
            generationConfig: {
              maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
              temperature: 0.7,
              ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}),
            },
          });
          
          result = await chat.sendMessage(finalPrompt);
          activeGeminiModel = usedModel;
          break;
        } catch (err) {
          console.warn(`[AI] Model ${usedModel} failed (${err.message}), trying fallback...`);
          if (err.message && err.message.includes('404')) {
            availableModelsCache = availableModelsCache.filter(m => m !== usedModel);
          }
          if (!/503|429|404|400|overloaded|unavailable/i.test(err.message)) {
            throw err;
          }
        }
      }

      if (!result || !chat) {
        throw new Error('All Gemini models are currently overloaded (503).');
      }

      let responseText = '';
      const MAX_TOOL_ROUNDS = 6;
      const executedTools = [];
      const isMultiStep = /\b(then|after that|and then|w mn b3d|mn b3d|moraha)\b/i.test(promptText);

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const functionCalls = result.response.functionCalls();
        if (!functionCalls || functionCalls.length === 0) {
          responseText = extractResponseText(result.response);
          break;
        }

        const functionResponses = [];
        const textFallback = [];
        for (const call of functionCalls) {
          console.log(`[AI Tool] Model requested ${call.name} with args:`, call.args);
          const toolResult = await executeDiscordTool(call.name, call.args, message);
          console.log(`[AI Tool] Execution result:`, toolResult);
          executedTools.push({ name: call.name, result: toolResult });

          functionResponses.push({
            functionResponse: { name: call.name, response: toolResult },
          });
          textFallback.push(`[System: Tool '${call.name}' returned: ${JSON.stringify(toolResult)}]`);
        }

        if (!isMultiStep) {
          responseText = formatToolSummary(executedTools);
          break;
        }

        try {
          result = await chat.sendMessage(functionResponses);
        } catch (apiErr) {
          if (apiErr.message.includes("Role 'function' is not supported") || apiErr.message.includes('400')) {
            result = await chat.sendMessage(textFallback.join('\n'));
          } else {
            throw apiErr;
          }
        }
        responseText = extractResponseText(result.response);
      }

      if (!responseText && executedTools.length > 0) {
        responseText = formatToolSummary(executedTools);
      }

      if (!responseText) throw new Error('Gemini returned an empty response');
      if (responseText.length > 2000) responseText = responseText.substring(0, 1996) + '...';

      console.log(`[AI] Successfully generated reply (${responseText.length} chars)`);
      await message.reply(responseText).catch(() => message.channel.send(responseText));
      sendLog(message.guild, `🤖 **AI Query:** <@${message.author.id}> mentioned the AI in <#${message.channel.id}>.`).catch(() => {});
    } catch (err) {
      console.error(`Gemini API Error: ${err.message}`);
      aiUserCooldowns.delete(message.author.id);
      await message.reply('😅 Sme7 lia, l-servers dyal AI 3amrin chwia had sa3a (503). 3awed jarreb mn b3d chwia!').catch(() => {});
    }
    return;
  }

  // DIRECT MUSIC COMMANDS
  const msgLower = message.content.toLowerCase();

  if (msgLower.startsWith('play ')) {
    const musicQuery = message.content.slice(5).trim();
    if (!distube) return message.reply('❌ Music ma kaynch (dependencies ma installerch).');
    if (!message.member.voice.channel) return message.reply('❌ Khassek tkon f voice channel bach tplayi l-music.');
    if (!musicQuery) return message.reply('❌ Kteb smit l-ghnya. Mithal: `play chkoun li gal`');

    try {
      await distube.play(message.member.voice.channel, musicQuery, {
        member: message.member,
        textChannel: message.channel,
        message,
      });
      return message.reply('🔎 3la rassi w 3ini, ana njibha daba...');
    } catch (e) {
      console.error(`[Music] play error: ${e.message}`);
      return message.reply('❌ Ma qdertch nplayi had l-7aja. Jarreb link aw smia khra.');
    }
  }

  if (msgLower === 'stop music' || msgLower === 'stop') {
    if (!distube) return message.reply('❌ Music ma kaynch.');
    const q = distube.getQueue(message.guild);
    if (!q) return message.reply('❌ Ma kaynch chi music khdama daba.');
    q.stop();
    return message.reply('⏹️ Safi w9eft l-music w msa7t l-queue.');
  }

  if (msgLower === 'skip music' || msgLower === 'skip') {
    if (!distube) return message.reply('❌ Music ma kaynch.');
    if (!message.member.voice.channel) return message.reply('❌ Khassek tkon f voice channel.');
    const q = distube.getQueue(message.guild);
    if (!q) return message.reply('❌ Ma kaynch chi music khdama daba.');
    try {
      const song = await q.skip();
      return message.reply(`⏭️ Dozt l-ghnya: \`${song && song.name ? song.name : 'Next song'}\`.`);
    } catch (e) {
      q.stop();
      return message.reply('⏹️ Hada akher track, w9eft l-music.');
    }
  }

  if (msgLower === 'leave voice' || msgLower === 'leave music') {
    if (!distube) return message.reply('❌ Music ma kaynch.');
    try {
      const q = distube.getQueue(message.guild);
      if (q) q.stop();
      await distube.voices.leave(message.guild);
      return message.reply('👋 Safi khrejt mn l-voice. Thllaw!');
    } catch (e) {}
  }

  // A. AJI COMMAND
  if (message.content.toLowerCase().startsWith('aji ')) {
    const hasMoveRole = MOVE_ROLE_ID && message.member.roles.cache.has(MOVE_ROLE_ID);
    const hasStaffRole = STAFF_ROLE_ID && message.member.roles.cache.has(STAFF_ROLE_ID);
    const isAdmin = message.member.permissions.has(PermissionsBitField.Flags.Administrator);

    if (!hasMoveRole && !hasStaffRole && !isAdmin) {
      return message.reply('❌ You do not have permission to use the `aji` command.').then(msg => setTimeout(() => msg.delete().catch(() => {}), 5000));
    }

    const targetMember = message.mentions.members.first();
    if (!targetMember) return message.reply('❌ Please mention a user to move. Example: `aji @Username`');

    const authorVoiceChannel = message.member.voice.channel;
    if (!authorVoiceChannel) return message.reply('❌ You must be in a voice channel yourself to pull someone to you.');

    const targetVoiceChannel = targetMember.voice.channel;
    if (!targetVoiceChannel) return message.reply(`❌ **${targetMember.displayName}** is not connected to any voice channel!`);

    try {
      await targetMember.voice.setChannel(authorVoiceChannel);
      await message.reply(`✅ Moved **${targetMember.displayName}** to your voice channel!`);
      await sendLog(message.guild, `🧲 **Move Action:** <@${message.author.id}> used \`aji\` to move <@${targetMember.id}> into their voice channel.`);
    } catch (err) {
      message.reply('❌ Failed to move the user. Make sure I have "Move Members" permissions.');
    }
    return;
  }

  // B. BROADCAST / SAY COMMAND
  if (message.content.startsWith('.say ')) {
    const hasStaffRole = STAFF_ROLE_ID && message.member.roles.cache.has(STAFF_ROLE_ID);
    const isAdmin = message.member.permissions.has(PermissionsBitField.Flags.Administrator);

    if (!hasStaffRole && !isAdmin) {
      return message.reply('❌ You do not have permission to use the `.say` command.').then(msg => setTimeout(() => msg.delete().catch(() => {}), 5000));
    }

    const broadcastText = message.content.slice(5).trim();
    if (!broadcastText) return;

    try {
      await message.delete();
      await message.channel.send(broadcastText);
      await sendLog(message.guild, `📢 **Broadcast:** <@${message.author.id}> used the \`.say\` command in <#${message.channel.id}>.`);
    } catch (err) {}
    return;
  }

  // C. VOICE ROOM CONTROL COMMANDS
  if (!message.content.startsWith('.a')) return;
  const args = message.content.slice(2).trim().split(/ +/);
  const command = args.shift().toLowerCase();
  const voiceChannel = message.member?.voice?.channel;

  if (!voiceChannel) return message.reply('❌ You must be connected to a voice channel to use room commands.');

  if (command === 'claim') {
    const currentOwner = roomOwners.get(voiceChannel.id);
    if (currentOwner && currentOwner !== message.author.id) {
      return message.reply('❌ This room is already actively owned by someone else in this session.');
    }
    try {
      roomOwners.set(voiceChannel.id, message.author.id);
      await voiceChannel.permissionOverwrites.edit(message.author.id, {
        ManageChannels: true,
        Connect: true,
        Speak: true,
        SendMessages: true,
        ReadMessageHistory: true,
      });
      await sendLog(message.guild, `🔑 **Room Claimed:** <@${message.author.id}> reclaimed ownership of \`${voiceChannel.name}\`.`);
      return message.reply('✅ You have successfully reclaimed ownership of this room! You can use `.a` commands again.');
    } catch (err) {
      return message.reply('❌ An error occurred while trying to claim the room.');
    }
  }

  const ownerId = roomOwners.get(voiceChannel.id);
  if (!ownerId || ownerId !== message.author.id) {
    return message.reply('❌ You can only manage a custom voice channel that you created! *(If the bot restarted, use `.a claim` first)*');
  }

  try {
    if (command === 'name') {
      const newName = args.join(' ');
      if (!newName) return message.reply('❌ Please provide a new name.');
      await voiceChannel.setName(`🔊 ${newName}`);
      await message.reply(`✅ Room renamed to **🔊 ${newName}**`);
    } else if (command === 'lock') {
      await voiceChannel.permissionOverwrites.edit(message.guild.id, { Connect: false });
      await message.reply('🔒 Room locked.');
    } else if (command === 'unlock') {
      await voiceChannel.permissionOverwrites.edit(message.guild.id, { Connect: null });
      await message.reply('🔓 Room unlocked.');
    } else if (command === 'limit') {
      const limit = parseInt(args[0], 10);
      if (isNaN(limit) || limit < 0 || limit > 99) return message.reply('❌ Please provide a valid number between 0 and 99.');
      await voiceChannel.setUserLimit(limit);
      await message.reply(limit === 0 ? '✅ Room user limit removed.' : `✅ Room limit set to **${limit}** users.`);
    } else if (command === 'add' || command === 'permit') {
      const targetUser = message.mentions.users.first();
      if (!targetUser) return message.reply('❌ Please mention a user to add.');
      await voiceChannel.permissionOverwrites.edit(targetUser.id, { Connect: true, ViewChannel: true, Speak: true });
      await message.reply(`✅ Added ${targetUser} to your room.`);
    } else if (command === 'reject') {
      const targetUser = message.mentions.users.first();
      if (!targetUser) return message.reply('❌ Please mention a user to reject.');
      await voiceChannel.permissionOverwrites.edit(targetUser.id, { Connect: false });

      const targetMember = await message.guild.members.fetch(targetUser.id).catch(() => null);
      if (targetMember && targetMember.voice.channelId === voiceChannel.id) await targetMember.voice.disconnect();
      await message.reply(`🚫 Rejected ${targetUser} from your room.`);
    }
  } catch (err) {
    message.reply('❌ An error occurred while executing that command.');
  }
});

client.login(process.env.DISCORD_TOKEN);