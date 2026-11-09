const { Client, GatewayIntentBits, ActivityType, ChannelType, PermissionsBitField, AuditLogEvent } = require('discord.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

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

// Google Gemini AI setup (100% Free tier on Google AI Studio)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
let activeGeminiModel = process.env.GEMINI_MODEL || null;
let genAI = null;
if (GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
}

// Dynamically auto-detect active model supported by the API key
async function getAvailableGeminiModel() {
  if (activeGeminiModel) return activeGeminiModel;
  if (!GEMINI_API_KEY) return 'gemini-3.5-flash-lite';

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`);
    if (res.ok) {
      const data = await res.json();
      const models = (data.models || [])
        .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
        .map(m => m.name.replace(/^models\//, ''));

      console.log('Available Gemini models for this key:', models);

      // Prioritized list of active free-tier models
      const priority = ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-flash'];
      for (const pref of priority) {
        if (models.includes(pref)) {
          activeGeminiModel = pref;
          console.log(`🤖 Auto-selected Gemini model: ${activeGeminiModel}`);
          return activeGeminiModel;
        }
      }

      const anyFlash = models.find(m => m.toLowerCase().includes('flash'));
      if (anyFlash) {
        activeGeminiModel = anyFlash;
        console.log(`🤖 Auto-selected flash model: ${activeGeminiModel}`);
        return activeGeminiModel;
      }

      if (models.length > 0) {
        activeGeminiModel = models[0];
        console.log(`🤖 Auto-selected model: ${activeGeminiModel}`);
        return activeGeminiModel;
      }
    }
  } catch (e) {
    console.error(`Could not fetch model list: ${e.message}`);
  }

  activeGeminiModel = 'gemini-3.5-flash-lite';
  return activeGeminiModel;
}

const aiUserCooldowns = new Map();
const AI_COOLDOWN_MS = 5000;
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
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.ManageChannels],
      },
    ];

    const staffRole = guild.roles.cache.get(STAFF_ROLE_ID);
    if (staffRole) {
      overwrites.push({
        id: staffRole.id,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory],
      });
    }

    const newChannel = await guild.channels.create({
      name: `verify-${member.displayName}`,
      type: ChannelType.GuildVoice,
      parent: (CATEGORY_ID && CATEGORY_ID.length > 5) ? CATEGORY_ID : null,
      permissionOverwrites: overwrites,
    });

    // Move the member in if they are already connected
    if (member.voice && member.voice.channelId) {
      await member.voice.setChannel(newChannel).catch(() => {});
    }

    // The bot talks to the person who wants to verify
    try {
      await newChannel.send(`👋 Salam <@${member.id}>! Daba ghadi yjiw staff bach yverify-iwk. Stenna chwia hna 🙂`);
    } catch (e) {}

    // Ping staff to come verify
    try {
      await newChannel.send(`<@&${STAFF_ROLE_ID}> New verification session for **${member.displayName}**. Please come verify them here!`);
    } catch (e) {}

    // Also DM the person as a heads-up
    try {
      await member.send(`👋 Salam ${member.displayName}! 3ayetna l staff bach yverify-iwk. Dkhol l <#${newChannel.id}> daba 🙂`);
    } catch (e) {}

    await sendLog(guild, `🛡️ **Verification Session:** <@${member.id}> started a verification session in \`${newChannel.name}\`.`);
    return { success: true, user: member.displayName, mention: `<@${member.id}>`, channel: newChannel.name };
  } catch (err) {
    return { success: false, error: `Failed to start verification: ${err.message}` };
  }
}

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}! Bot is online and ready.`);
  if (!GEMINI_API_KEY) {
    console.log("⚠️ GEMINI_API_KEY is missing. Mention-based AI replies will be disabled.");
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
    let action = "";
    if (!oldState.serverMute && newState.serverMute) action = "server muted";
    else if (oldState.serverMute && !newState.serverMute) action = "server unmuted";
    else if (!oldState.serverDeaf && newState.serverDeaf) action = "server deafened";
    else if (oldState.serverDeaf && !newState.serverDeaf) action = "server undeafened";

    if (action) {
      let executorString = "A moderator";
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
      const canView = perms ? perms.has(PermissionsBitField.Flags.ViewChannel) : false;
      console.log(`[Cleanup] Deleting empty room "${channel.name}" (members=0, bot ManageChannels=${canManage}, ViewChannel=${canView})`);

      try {
        roomOwners.delete(channel.id);
        await channel.delete();
        await sendLog(channel.guild, `🗑️ **Room Deleted:** Auto-deleted empty temporary channel \`${channel.name}\`.`);
      } catch (err) {
        console.error(`[Cleanup] Failed to delete "${channel.name}" (ManageChannels=${canManage}, ViewChannel=${canView}): ${err.message}`);
        await sendLog(channel.guild, `⚠️ **Cleanup Failed:** \`${channel.name}\` — ${err.message} (bot has ManageChannels: ${canManage}).`).catch(() => {});
        // Retry once shortly after (handles rare races / permission propagation)
        setTimeout(async () => {
          try {
            const ch = channel.guild.channels.cache.get(channel.id);
            if (ch && ch.members.size === 0) {
              await ch.delete();
              await sendLog(channel.guild, `🗑️ **Room Deleted:** Auto-deleted empty temporary channel \`${ch.name}\`.`).catch(() => {});
            }
          } catch (e) {
            console.error(`[Cleanup] Retry failed to delete "${channel.name}": ${e.message}`);
          }
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
          allow: [PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory],
        },
        {
          id: client.user.id,
          allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.ManageChannels],
        }
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
        description: 'Assigns/gives a Discord server role to a user. Used when an authorized staff/admin asks to give someone a role (e.g. "3tih role Member", "give @User role VIP", "3ti role l @User").',
        parameters: {
          type: 'OBJECT',
          properties: {
            target_user: {
              type: 'STRING',
              description: 'The username, display name, mention, or user ID of the person to receive the role',
            },
            role_name: {
              type: 'STRING',
              description: 'The name or mention of the role to assign (e.g. VIP, Member, Staff)',
            },
          },
          required: ['target_user', 'role_name'],
        },
      },
      {
        name: 'remove_role',
        description: 'Removes/takes away a Discord server role from a user (e.g. "7eyed role VIP mn @User", "remove role Member from @User").',
        parameters: {
          type: 'OBJECT',
          properties: {
            target_user: {
              type: 'STRING',
              description: 'The username, display name, mention, or user ID of the person to remove the role from',
            },
            role_name: {
              type: 'STRING',
              description: 'The name or mention of the role to remove',
            },
          },
          required: ['target_user', 'role_name'],
        },
      },
      {
        name: 'mute_member',
        description: 'Mutes a member\'s microphone in their voice channel (Voice Mute only. Does NOT kick, does NOT timeout, does NOT remove roles, and does NOT lock channels).',
        parameters: {
          type: 'OBJECT',
          properties: {
            target_user: {
              type: 'STRING',
              description: 'The username, display name, mention, or user ID of the person to voice-mute',
            },
            reason: {
              type: 'STRING',
              description: 'Optional reason for voice muting',
            },
          },
          required: ['target_user'],
        },
      },
      {
        name: 'unmute_member',
        description: 'Unmutes a member in voice channel and removes server timeout when requested by authorized staff.',
        parameters: {
          type: 'OBJECT',
          properties: {
            target_user: {
              type: 'STRING',
              description: 'The username, display name, mention, or user ID of the person to unmute',
            },
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
            target_user: {
              type: 'STRING',
              description: 'The username, display name, mention, or user ID of the person to move',
            },
            destination: {
              type: 'STRING',
              description: 'Optional channel name or ID to move them to (defaults to caller voice channel)',
            },
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
            target_user: {
              type: 'STRING',
              description: 'The username, display name, mention, or user ID of the person to disconnect',
            },
            reason: {
              type: 'STRING',
              description: 'Optional reason for disconnecting',
            },
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
            target_user: {
              type: 'STRING',
              description: 'The username, display name, mention, or user ID of the person to deafen',
            },
          },
          required: ['target_user'],
        },
      },
      {
        name: 'undeafen_member',
        description: 'Removes server deafen from a user in voice channel so they can hear again.',
        parameters: {
          type: 'OBJECT',
          properties: {
            target_user: {
              type: 'STRING',
              description: 'The username, display name, mention, or user ID of the person to undeafen',
            },
          },
          required: ['target_user'],
        },
      },
      {
        name: 'create_channel',
        description: 'Creates a new text or voice channel in the server (e.g. "dir channel smito General", "create a voice channel named Gaming", "sawb channel voice").',
        parameters: {
          type: 'OBJECT',
          properties: {
            name: {
              type: 'STRING',
              description: 'The name of the new channel',
            },
            type: {
              type: 'STRING',
              description: 'The channel type: "text" or "voice" (defaults to text)',
            },
            category: {
              type: 'STRING',
              description: 'Optional category name or ID to place the channel in',
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'create_role',
        description: 'Creates a new server role (e.g. "dir role smito VIP", "create role Member", "sawb role Admin").',
        parameters: {
          type: 'OBJECT',
          properties: {
            name: {
              type: 'STRING',
              description: 'The name of the new role',
            },
            color: {
              type: 'STRING',
              description: 'Optional hex color for the role, like "#FF0000"',
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'move_all_members',
        description: 'Moves EVERY member currently in a source voice channel into a destination voice channel (e.g. "7rekk ga3 li f channel X l channel Y", "move everyone to my channel", "jib ga3 li f l-voice l hna").',
        parameters: {
          type: 'OBJECT',
          properties: {
            source_channel: {
              type: 'STRING',
              description: 'Name or ID of the source voice channel, or "here"/"my channel" for the caller current channel',
            },
            destination_channel: {
              type: 'STRING',
              description: 'Name or ID of the destination voice channel, or "here"/"my channel" for the caller current channel',
            },
          },
          required: ['destination_channel'],
        },
      },
      {
        name: 'move_members',
        description: 'Moves several specific members into a voice channel (e.g. "jbed @A w @B l hna", "move @A and @B to my channel", "jib @A, @B l voice").',
        parameters: {
          type: 'OBJECT',
          properties: {
            target_users: {
              type: 'STRING',
              description: 'Comma-separated list of usernames, mentions, or user IDs to move',
            },
            destination: {
              type: 'STRING',
              description: 'Optional channel name or ID to move them to (defaults to the caller voice channel)',
            },
          },
          required: ['target_users'],
        },
      },
      {
        name: 'dm_members',
        description: 'Sends a private direct message (DM) to one or multiple members (e.g. "sift l @User f privé: salam", "dm @A and @B the rules").',
        parameters: {
          type: 'OBJECT',
          properties: {
            target_users: {
              type: 'STRING',
              description: 'Comma-separated list of usernames, mentions, or user IDs to message',
            },
            message_text: {
              type: 'STRING',
              description: 'The private message text to send',
            },
          },
          required: ['target_users', 'message_text'],
        },
      },
      {
        name: 'start_verification',
        description: 'Starts a verification session: creates a private verify channel, tags staff to come verify, and talks to the person (e.g. "bghit nverify", "call staff to verify me", "3ayet l staff yverify-iw @User").',
        parameters: {
          type: 'OBJECT',
          properties: {
            target_user: {
              type: 'STRING',
              description: 'Optional username, mention, or user ID of the person to verify (defaults to the caller)',
            },
          },
          required: [],
        },
      },
      {
        name: 'play_music',
        description: 'Asks the Jockie Music bot to play a song by typing the m!p command in chat (e.g. "play some chill music", "3zef chi song", "diro chi 7aja").',
        parameters: {
          type: 'OBJECT',
          properties: {
            query: {
              type: 'STRING',
              description: 'The song name, artist, or link to play',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'skip_music',
        description: 'Asks the Jockie Music bot to skip the current song by typing m!s in chat.',
        parameters: {
          type: 'OBJECT',
          properties: {},
          required: [],
        },
      },
      {
        name: 'stop_music',
        description: 'Asks the Jockie Music bot to stop the music by typing m!stop in chat.',
        parameters: {
          type: 'OBJECT',
          properties: {},
          required: [],
        },
      },
      {
        name: 'leave_music',
        description: 'Asks the Jockie Music bot to leave the voice channel by typing m!leave in chat.',
        parameters: {
          type: 'OBJECT',
          properties: {},
          required: [],
        },
      },
      {
        name: 'delete_channel',
        description: 'Deletes a text or voice channel (e.g. "ms7 channel X", "delete channel #general", "7eyed channel smito Y").',
        parameters: {
          type: 'OBJECT',
          properties: {
            channel_name: {
              type: 'STRING',
              description: 'The name, mention, or ID of the channel to delete',
            },
          },
          required: ['channel_name'],
        },
      },
      {
        name: 'delete_role',
        description: 'Deletes a server role (e.g. "ms7 role VIP", "delete role Member", "7eyed role smito X").',
        parameters: {
          type: 'OBJECT',
          properties: {
            role_name: {
              type: 'STRING',
              description: 'The name, mention, or ID of the role to delete',
            },
          },
          required: ['role_name'],
        },
      },
    ],
  },
];

// Helper to find a role by name, mention, or ID
function findRole(guild, roleQuery) {
  if (!roleQuery) return null;
  const clean = roleQuery.replace(/^[<@&>#\s]+/, '').replace(/[>\s]+$/, '').trim().toLowerCase();

  if (/^\d{17,20}$/.test(clean)) {
    const role = guild.roles.cache.get(clean);
    if (role) return role;
  }

  let matched = guild.roles.cache.find(r => r.name.toLowerCase() === clean);
  if (matched) return matched;

  matched = guild.roles.cache.find(r => r.name.toLowerCase().includes(clean));
  return matched || null;
}

// Helper to find a channel by name, mention, or ID (optionally filtered by type)
function findChannel(guild, query, type) {
  if (!query) return null;
  const clean = query.replace(/^[<#>#\s]+/, '').replace(/[>\s]+$/, '').trim().toLowerCase();
  if (/^\d{17,20}$/.test(clean)) {
    const ch = guild.channels.cache.get(clean);
    if (ch) return ch;
  }

  const matches = (name) => {
    if (type === 'category' && name.type !== ChannelType.GuildCategory) return false;
    if (type === 'voice' && !name.isVoiceBased()) return false;
    if (type === 'text' && !name.isTextBased()) return false;
    return name.name.toLowerCase() === clean;
  };

  let matched = guild.channels.cache.find(matches);
  if (matched) return matched;

  const includes = (name) => {
    if (type === 'category' && name.type !== ChannelType.GuildCategory) return false;
    if (type === 'voice' && !name.isVoiceBased()) return false;
    if (type === 'text' && !name.isTextBased()) return false;
    return name.name.toLowerCase().includes(clean);
  };
  matched = guild.channels.cache.find(includes);
  return matched || null;
}

// Helper to find a voice channel by name or ID
function findVoiceChannel(guild, query) {
  return findChannel(guild, query, 'voice');
}

// Resolve one or multiple members from mentions + a comma-separated string (deduped)
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

// Extract the plain text from a Gemini response (skips "thought" parts on thinking models)
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

// Strict role verification check for managing roles
function checkRoleManagementPermissions(caller, role, guild) {
  const isOwner = guild.ownerId === caller.id;
  const isAdmin = caller.permissions.has(PermissionsBitField.Flags.Administrator);
  const canManageRoles = caller.permissions.has(PermissionsBitField.Flags.ManageRoles);
  const hasStaffRole = STAFF_ROLE_ID && caller.roles.cache.has(STAFF_ROLE_ID);

  if (!isOwner && !isAdmin && !canManageRoles && !hasStaffRole) {
    return {
      allowed: false,
      error: `Permission denied: ${caller.displayName} does not have permission to manage roles. Only staff and administrators can give or remove roles.`,
    };
  }

  const botMember = guild.members.me;
  if (role.position >= botMember.roles.highest.position) {
    return {
      allowed: false,
      error: `Cannot manage the "${role.name}" role because it is higher than or equal to my bot role in server hierarchy. Move my bot role higher in Server Settings.`,
    };
  }

  if (!isOwner && role.position >= caller.roles.highest.position) {
    return {
      allowed: false,
      error: `Permission denied: You cannot manage the "${role.name}" role because its position is equal to or higher than your own highest role.`,
    };
  }

  if (role.managed) {
    return {
      allowed: false,
      error: `Cannot manage "${role.name}" because it is automatically managed by an integration or Discord bot.`,
    };
  }

  return { allowed: true };
}

// Helper to find a member in guild by mention, ID, or name
async function findTargetMember(guild, query, mentions, botId) {
  if (mentions && mentions.members && mentions.members.size > 0) {
    const target = mentions.members.find(m => m.id !== botId);
    if (target) return target;
  }

  if (!query) return null;

  const idMatch = query.match(/\d{17,20}/);
  if (idMatch) {
    try {
      const byId = await guild.members.fetch(idMatch[0]);
      if (byId) return byId;
    } catch (e) {}
  }

  const cleanName = query.replace(/^[@🔊\s]+/, '').toLowerCase().trim();
  if (!cleanName) return null;

  try {
    const searched = await guild.members.fetch({ query: cleanName, limit: 5 });
    if (searched && searched.size > 0) {
      return searched.first();
    }
  } catch (e) {}

  return null;
}

// Permission checkers
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

// Tool executor function with strict role verification
async function executeDiscordTool(name, args, message) {
  const caller = message.member;

  // Tools that don't operate on a single target user (no target_user lookup needed)
  const noTargetTools = ['create_channel', 'create_role', 'move_all_members', 'move_members', 'dm_members', 'start_verification', 'play_music', 'skip_music', 'stop_music', 'leave_music', 'delete_channel', 'delete_role'];

  let targetMember = null;
  if (!noTargetTools.includes(name)) {
    targetMember = await findTargetMember(message.guild, args.target_user, message.mentions, message.client.user.id);
    if (!targetMember) {
      return {
        success: false,
        error: `Could not find any user matching "${args.target_user}". Ask caller to mention them like @Username.`,
      };
    }
  }

  // 1. GIVE ROLE
  if (name === 'give_role') {
    const role = findRole(message.guild, args.role_name);
    if (!role) {
      return { success: false, error: `Role "${args.role_name}" not found in this server.` };
    }

    const check = checkRoleManagementPermissions(caller, role, message.guild);
    if (!check.allowed) return { success: false, error: check.error };

    try {
      await targetMember.roles.add(role);
      await sendLog(message.guild, `🛡️ **AI Role Grant:** <@${caller.id}> gave the role \`${role.name}\` to <@${targetMember.id}>.`);
      return {
        success: true,
        user: targetMember.displayName,
        mention: `<@${targetMember.id}>`,
        role: role.name,
        action: 'added role',
      };
    } catch (err) {
      return { success: false, error: `Failed to add role ${role.name}: ${err.message}` };
    }
  }

  // 2. REMOVE ROLE
  if (name === 'remove_role') {
    const role = findRole(message.guild, args.role_name);
    if (!role) {
      return { success: false, error: `Role "${args.role_name}" not found in this server.` };
    }

    if (ROLE_ID && role.id === ROLE_ID) {
      return {
        success: false,
        error: "Cannot remove the main server membership role. Doing so would lock the user out of the server.",
      };
    }

    const check = checkRoleManagementPermissions(caller, role, message.guild);
    if (!check.allowed) return { success: false, error: check.error };

    try {
      await targetMember.roles.remove(role);
      await sendLog(message.guild, `🛡️ **AI Role Remove:** <@${caller.id}> removed the role \`${role.name}\` from <@${targetMember.id}>.`);
      return {
        success: true,
        user: targetMember.displayName,
        mention: `<@${targetMember.id}>`,
        role: role.name,
        action: 'removed role',
      };
    } catch (err) {
      return { success: false, error: `Failed to remove role ${role.name}: ${err.message}` };
    }
  }

  // 3. MUTE MEMBER (Strictly Voice Mute - No timeouts, no kicks, no locked channels)
  if (name === 'mute_member') {
    if (!canCallerModerate(caller)) {
      return {
        success: false,
        error: `Permission denied: ${caller.displayName} does not have moderator or staff permissions to mute people. Explain in Moroccan Darija that only staff can mute.`,
      };
    }

    if (targetMember.id === message.client.user.id) {
      return { success: false, error: 'Cannot mute the bot.' };
    }

    if (targetMember.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return { success: false, error: 'Cannot mute an Administrator.' };
    }

    // Must be in a voice channel to voice-mute
    if (!targetMember.voice.channel) {
      return {
        success: false,
        error: `${targetMember.displayName} is not connected to any voice channel right now. Tell the caller in Moroccan Darija that the user must be in a voice channel to be muted.`,
      };
    }

    try {
      // Pure voice mute: mutes mic without kicking, without timeout, and without touching server roles
      await targetMember.voice.setMute(true, args.reason || `Voice muted via AI by ${caller.displayName}`);
      await sendLog(message.guild, `🔇 **AI Voice Mute:** <@${caller.id}> muted <@${targetMember.id}> in \`${targetMember.voice.channel.name}\`.`);
      return {
        success: true,
        user: targetMember.displayName,
        mention: `<@${targetMember.id}>`,
        channel: targetMember.voice.channel.name,
      };
    } catch (err) {
      return { success: false, error: `Failed to voice-mute ${targetMember.displayName}: ${err.message}` };
    }
  }

  // 4. UNMUTE MEMBER
  if (name === 'unmute_member') {
    if (!canCallerModerate(caller)) {
      return {
        success: false,
        error: `Permission denied: ${caller.displayName} does not have permission to unmute.`,
      };
    }

    try {
      if (targetMember.voice.channel) {
        await targetMember.voice.setMute(false, `Unmuted via AI by ${caller.displayName}`);
      }
      if (targetMember.isCommunicationDisabled()) {
        await targetMember.timeout(null, `Unmuted via AI by ${caller.displayName}`);
      }

      await sendLog(message.guild, `🔊 **AI Unmute:** <@${caller.id}> used AI to unmute <@${targetMember.id}>.`);
      return {
        success: true,
        user: targetMember.displayName,
        mention: `<@${targetMember.id}>`,
      };
    } catch (err) {
      return { success: false, error: `Failed to unmute: ${err.message}` };
    }
  }

  // 5. MOVE MEMBER
  if (name === 'move_member') {
    if (!canCallerMove(caller)) {
      return {
        success: false,
        error: `Permission denied: ${caller.displayName} does not have permission to move members. Explain in Moroccan Darija that they need move permission.`,
      };
    }

    const targetVoice = targetMember.voice.channel;
    if (!targetVoice) {
      return {
        success: false,
        error: `${targetMember.displayName} is not in any voice channel right now.`,
      };
    }

    let destinationChannel = caller.voice.channel;
    if (args.destination && args.destination.toLowerCase() !== 'me' && args.destination.toLowerCase() !== 'here') {
      const cleanDest = args.destination.toLowerCase().replace(/^[#🔊\s]+/, '').trim();
      const found = message.guild.channels.cache.find(
        c => c.isVoiceBased() && (c.id === cleanDest || c.name.toLowerCase().includes(cleanDest))
      );
      if (found) destinationChannel = found;
    }

    if (!destinationChannel) {
      return {
        success: false,
        error: `Caller ${caller.displayName} is not connected to any voice channel and no valid target channel was found.`,
      };
    }

    try {
      await targetMember.voice.setChannel(destinationChannel);
      await sendLog(message.guild, `🧲 **AI Move:** <@${caller.id}> used AI to move <@${targetMember.id}> into \`${destinationChannel.name}\`.`);
      return {
        success: true,
        user: targetMember.displayName,
        channel: destinationChannel.name,
        mention: `<@${targetMember.id}>`,
      };
    } catch (err) {
      return { success: false, error: `Failed to move: ${err.message}` };
    }
  }

  // 6. DISCONNECT MEMBER FROM VOICE
  if (name === 'disconnect_member') {
    if (!canCallerMove(caller)) {
      return {
        success: false,
        error: `Permission denied: ${caller.displayName} does not have permission to disconnect members.`,
      };
    }

    if (!targetMember.voice.channel) {
      return { success: false, error: `${targetMember.displayName} is not connected to voice.` };
    }

    try {
      await targetMember.voice.disconnect(args.reason || `Disconnected via AI by ${caller.displayName}`);
      await sendLog(message.guild, `🚪 **AI Voice Kick:** <@${caller.id}> disconnected <@${targetMember.id}> from voice.`);
      return {
        success: true,
        user: targetMember.displayName,
        mention: `<@${targetMember.id}>`,
      };
    } catch (err) {
      return { success: false, error: `Failed to disconnect: ${err.message}` };
    }
  }

  // 7. DEAFEN MEMBER
  if (name === 'deafen_member') {
    const canDeaf = caller.permissions.has(PermissionsBitField.Flags.DeafenMembers);
    if (!canCallerModerate(caller) && !canDeaf) {
      return {
        success: false,
        error: `Permission denied: ${caller.displayName} does not have permission to deafen members.`,
      };
    }

    if (!targetMember.voice.channel) {
      return { success: false, error: `${targetMember.displayName} is not connected to voice.` };
    }

    try {
      await targetMember.voice.setDeaf(true, `Deafened via AI by ${caller.displayName}`);
      await sendLog(message.guild, `🔇 **AI Deafen:** <@${caller.id}> deafened <@${targetMember.id}> in voice.`);
      return {
        success: true,
        user: targetMember.displayName,
        mention: `<@${targetMember.id}>`,
      };
    } catch (err) {
      return { success: false, error: `Failed to deafen: ${err.message}` };
    }
  }

  // 8. UNDEAFEN MEMBER
  if (name === 'undeafen_member') {
    const canDeaf = caller.permissions.has(PermissionsBitField.Flags.DeafenMembers);
    if (!canCallerModerate(caller) && !canDeaf) {
      return {
        success: false,
        error: `Permission denied: ${caller.displayName} does not have permission to undeafen members.`,
      };
    }

    if (!targetMember.voice.channel) {
      return { success: false, error: `${targetMember.displayName} is not connected to voice.` };
    }

    try {
      await targetMember.voice.setDeaf(false, `Undeafened via AI by ${caller.displayName}`);
      await sendLog(message.guild, `🔊 **AI Undeafen:** <@${caller.id}> undeafened <@${targetMember.id}> in voice.`);
      return {
        success: true,
        user: targetMember.displayName,
        mention: `<@${targetMember.id}>`,
      };
    } catch (err) {
      return { success: false, error: `Failed to undeafen: ${err.message}` };
    }
  }

  // 9. CREATE CHANNEL
  if (name === 'create_channel') {
    const isOwner = message.guild.ownerId === caller.id;
    const isAdmin = caller.permissions.has(PermissionsBitField.Flags.Administrator);
    const canManageChannels = caller.permissions.has(PermissionsBitField.Flags.ManageChannels);
    const hasStaffRole = STAFF_ROLE_ID && caller.roles.cache.has(STAFF_ROLE_ID);

    if (!isOwner && !isAdmin && !canManageChannels && !hasStaffRole) {
      return { success: false, error: `Permission denied: ${caller.displayName} does not have permission to create channels. Explain in Moroccan Darija that only staff/admins can create channels.` };
    }

    const channelName = (args.name || '').trim();
    if (!channelName) return { success: false, error: 'A channel name is required.' };

    const typeRaw = (args.type || 'text').toLowerCase();
    const isVoice = typeRaw === 'voice' || typeRaw === 'vocal' || typeRaw === 'vc';
    const channelType = isVoice ? ChannelType.GuildVoice : ChannelType.GuildText;

    let parentId = null;
    if (args.category) {
      const cat = findChannel(message.guild, args.category, 'category');
      if (cat) parentId = cat.id;
    }

    try {
      const newChannel = await message.guild.channels.create({
        name: channelName,
        type: channelType,
        ...(parentId ? { parent: parentId } : {}),
      });
      await sendLog(message.guild, `➕ **AI Channel Created:** <@${caller.id}> created ${isVoice ? 'voice' : 'text'} channel \`${newChannel.name}\`.`);
      return { success: true, name: newChannel.name, mention: `<#${newChannel.id}>`, type: isVoice ? 'voice' : 'text' };
    } catch (err) {
      return { success: false, error: `Failed to create channel: ${err.message}` };
    }
  }

  // 10. CREATE ROLE
  if (name === 'create_role') {
    const isOwner = message.guild.ownerId === caller.id;
    const isAdmin = caller.permissions.has(PermissionsBitField.Flags.Administrator);
    const canManageRoles = caller.permissions.has(PermissionsBitField.Flags.ManageRoles);
    const hasStaffRole = STAFF_ROLE_ID && caller.roles.cache.has(STAFF_ROLE_ID);

    if (!isOwner && !isAdmin && !canManageRoles && !hasStaffRole) {
      return { success: false, error: `Permission denied: ${caller.displayName} does not have permission to create roles. Explain in Moroccan Darija that only staff/admins can create roles.` };
    }

    const roleName = (args.name || '').trim();
    if (!roleName) return { success: false, error: 'A role name is required.' };

    const hex = (args.color || '').replace(/^#/, '').toUpperCase();
    const roleData = { name: roleName };
    if (/^[0-9A-F]{6}$/.test(hex)) roleData.color = hex;

    try {
      const role = await message.guild.roles.create(roleData);
      await sendLog(message.guild, `➕ **AI Role Created:** <@${caller.id}> created role \`${role.name}\`.`);
      return { success: true, name: role.name, mention: `<@&${role.id}>` };
    } catch (err) {
      return { success: false, error: `Failed to create role: ${err.message}` };
    }
  }

  // 11. MOVE ALL MEMBERS FROM ONE VOICE CHANNEL TO ANOTHER
  if (name === 'move_all_members') {
    if (!canCallerMove(caller)) {
      return { success: false, error: `Permission denied: ${caller.displayName} does not have permission to move members. Explain in Moroccan Darija that they need move permission.` };
    }

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

    if (!source) return { success: false, error: 'Could not find the source voice channel. Ask the caller to specify which channel to move people from.' };
    if (!destination) return { success: false, error: 'Could not find the destination voice channel, and the caller is not connected to a voice channel.' };
    if (source.id === destination.id) return { success: false, error: 'Source and destination channels are the same.' };

    const members = Array.from(source.members.values());
    if (members.length === 0) return { success: false, error: `No members are in "${source.name}" to move.` };

    let moved = 0;
    const errors = [];
    for (const m of members) {
      try {
        await m.voice.setChannel(destination);
        moved++;
      } catch (e) {
        errors.push(`${m.displayName}: ${e.message}`);
      }
    }

    await sendLog(message.guild, `🧲 **AI Bulk Move:** <@${caller.id}> moved ${moved} member(s) from \`${source.name}\` to \`${destination.name}\`.`);
    return { success: true, moved, source: source.name, dest: destination.name, errors };
  }

  // 12. MOVE MULTIPLE SPECIFIC MEMBERS
  if (name === 'move_members') {
    if (!canCallerMove(caller)) {
      return { success: false, error: `Permission denied: ${caller.displayName} does not have permission to move members. Explain in Moroccan Darija that they need move permission.` };
    }

    const members = await resolveMembers(message.guild, args.target_users, message.mentions, message.client.user.id);
    if (members.length === 0) {
      return { success: false, error: 'Could not find any of the mentioned users to move. Ask the caller to mention them like @Username.' };
    }

    let destination = caller.voice.channel;
    if (args.destination && !['here', 'me', 'my channel', 'my voice', 'hna'].includes(args.destination.toLowerCase().trim())) {
      const found = findVoiceChannel(message.guild, args.destination);
      if (found) destination = found;
    }

    if (!destination) return { success: false, error: 'No destination voice channel found and the caller is not connected to a voice channel.' };

    let moved = 0;
    const errors = [];
    for (const m of members) {
      try {
        await m.voice.setChannel(destination);
        moved++;
      } catch (e) {
        errors.push(`${m.displayName}: ${e.message}`);
      }
    }

    await sendLog(message.guild, `🧲 **AI Bulk Move (selected):** <@${caller.id}> moved ${moved} member(s) into \`${destination.name}\`.`);
    return { success: true, moved, dest: destination.name, errors };
  }

  // 13. SEND PRIVATE MESSAGES TO ONE OR MULTIPLE MEMBERS
  if (name === 'dm_members') {
    const isOwner = message.guild.ownerId === caller.id;
    const isAdmin = caller.permissions.has(PermissionsBitField.Flags.Administrator);
    const hasStaffRole = STAFF_ROLE_ID && caller.roles.cache.has(STAFF_ROLE_ID);

    if (!isOwner && !isAdmin && !hasStaffRole) {
      return { success: false, error: `Permission denied: ${caller.displayName} does not have permission to send private messages. Explain in Moroccan Darija that only staff/admins can do this.` };
    }

    const messageText = (args.message_text || '').trim();
    if (!messageText) return { success: false, error: 'A private message text is required.' };

    const members = await resolveMembers(message.guild, args.target_users, message.mentions, message.client.user.id);
    if (members.length === 0) {
      return { success: false, error: 'Could not find any of the mentioned users to message. Ask the caller to mention them like @Username.' };
    }

    let sent = 0;
    const errors = [];
    for (const m of members) {
      try {
        await m.send(messageText);
        sent++;
      } catch (e) {
        errors.push(`${m.displayName}: ${e.message}`);
      }
    }

    await sendLog(message.guild, `📩 **AI DM:** <@${caller.id}> sent a private message to ${sent} member(s).`);
    return { success: true, sent, errors };
  }

  // 14. START VERIFICATION (tag staff + talk to the person)
  if (name === 'start_verification') {
    let target = caller;

    if (args.target_user && args.target_user.trim()) {
      const isOwner = message.guild.ownerId === caller.id;
      const isAdmin = caller.permissions.has(PermissionsBitField.Flags.Administrator);
      const hasStaffRole = STAFF_ROLE_ID && caller.roles.cache.has(STAFF_ROLE_ID);

      if (!isOwner && !isAdmin && !hasStaffRole) {
        return { success: false, error: 'You can only start verification for yourself. Ask a staff member to verify someone else.' };
      }

      target = await findTargetMember(message.guild, args.target_user, message.mentions, message.client.user.id);
      if (!target) {
        return { success: false, error: `Could not find user matching "${args.target_user}".` };
      }
    }

    return await startVerification(message.guild, target);
  }

  // 15. MUSIC CONTROL — bot types Jockie Music commands (m!p, m!s, m!stop, m!leave) in chat
  if (name === 'play_music') {
    const query = (args.query || '').trim();
    if (!query) return { success: false, error: 'A song query is required.' };
    try {
      await message.channel.send(`m!p ${query}`);
      return { success: true, query };
    } catch (e) {
      return { success: false, error: `Failed to send music command: ${e.message}` };
    }
  }

  if (name === 'skip_music') {
    try {
      await message.channel.send('m!s');
      return { success: true };
    } catch (e) {
      return { success: false, error: `Failed to skip: ${e.message}` };
    }
  }

  if (name === 'stop_music') {
    try {
      await message.channel.send('m!stop');
      return { success: true };
    } catch (e) {
      return { success: false, error: `Failed to stop: ${e.message}` };
    }
  }

  if (name === 'leave_music') {
    try {
      await message.channel.send('m!leave');
      return { success: true };
    } catch (e) {
      return { success: false, error: `Failed to leave: ${e.message}` };
    }
  }

  // 16. DELETE CHANNEL
  if (name === 'delete_channel') {
    const isOwner = message.guild.ownerId === caller.id;
    const isAdmin = caller.permissions.has(PermissionsBitField.Flags.Administrator);
    const canManageChannels = caller.permissions.has(PermissionsBitField.Flags.ManageChannels);
    const hasStaffRole = STAFF_ROLE_ID && caller.roles.cache.has(STAFF_ROLE_ID);

    if (!isOwner && !isAdmin && !canManageChannels && !hasStaffRole) {
      return { success: false, error: `Permission denied: ${caller.displayName} does not have permission to delete channels.` };
    }

    const target = findChannel(message.guild, args.channel_name);
    if (!target) return { success: false, error: `Channel "${args.channel_name}" not found in this server.` };

    try {
      const chName = target.name;
      await target.delete();
      await sendLog(message.guild, `🗑️ **AI Channel Deleted:** <@${caller.id}> deleted channel \`${chName}\`.`);
      return { success: true, name: chName };
    } catch (e) {
      return { success: false, error: `Failed to delete channel: ${e.message}` };
    }
  }

  // 17. DELETE ROLE
  if (name === 'delete_role') {
    const isOwner = message.guild.ownerId === caller.id;
    const isAdmin = caller.permissions.has(PermissionsBitField.Flags.Administrator);
    const canManageRoles = caller.permissions.has(PermissionsBitField.Flags.ManageRoles);
    const hasStaffRole = STAFF_ROLE_ID && caller.roles.cache.has(STAFF_ROLE_ID);

    if (!isOwner && !isAdmin && !canManageRoles && !hasStaffRole) {
      return { success: false, error: `Permission denied: ${caller.displayName} does not have permission to delete roles.` };
    }

    const role = findRole(message.guild, args.role_name);
    if (!role) return { success: false, error: `Role "${args.role_name}" not found in this server.` };

    if (ROLE_ID && role.id === ROLE_ID) {
      return { success: false, error: 'Cannot delete the main server membership role.' };
    }
    if (role.managed) {
      return { success: false, error: `Cannot delete "${role.name}" because it is managed by an integration.` };
    }

    const botMember = message.guild.members.me;
    if (role.position >= botMember.roles.highest.position) {
      return { success: false, error: `Cannot delete "${role.name}" because it is higher than or equal to my bot role.` };
    }
    if (!isOwner && role.position >= caller.roles.highest.position) {
      return { success: false, error: `Permission denied: the "${role.name}" role is equal to or higher than your own highest role.` };
    }

    try {
      const roleName = role.name;
      await role.delete();
      await sendLog(message.guild, `🗑️ **AI Role Deleted:** <@${caller.id}> deleted role \`${roleName}\`.`);
      return { success: true, name: roleName };
    } catch (e) {
      return { success: false, error: `Failed to delete role: ${e.message}` };
    }
  }

  return { success: false, error: `Unknown action: ${name}` };
}

// 4. Handle Messages & Commands
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  // AI replies when directly mentioned OR when someone replies to the bot's message
  const botMention = client.user ? new RegExp(`<@!?${client.user.id}>`, 'g') : null;
  const isMentioned = botMention ? botMention.test(message.content) : false;

  let isReplyToBot = false;
  let referencedMessage = null;

  if (message.reference && message.reference.messageId) {
    try {
      referencedMessage = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
      if (referencedMessage && referencedMessage.author.id === client.user.id) {
        isReplyToBot = true;
      }
    } catch (e) {}
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

    // 1. Build multi-user conversation context from recent channel messages
    let channelContext = '';
    try {
      const recentMessages = await message.channel.messages.fetch({ limit: 10, before: message.id }).catch(() => null);
      if (recentMessages && recentMessages.size > 0) {
        const chronological = Array.from(recentMessages.values())
          .filter(m => !m.author.bot || m.author.id === client.user.id) // Only users and this bot
          .filter(m => (Date.now() - m.createdTimestamp) < 30 * 60 * 1000) // Within last 30 minutes
          .reverse(); // Chronological order

        if (chronological.length > 0) {
          channelContext = chronological.map(m => {
            const sender = m.author.id === client.user.id ? 'kho Kokiee (Bot)' : (m.member?.displayName || m.author.username);
            const cleanContent = botMention ? m.content.replace(botMention, '').trim() : m.content.trim();
            return `[${sender}]: ${cleanContent}`;
          }).filter(line => line.trim().length > 0).join('\n');
        }
      }
    } catch (contextErr) {
      console.warn(`[AI Multi-User Context] Warning: ${contextErr.message}`);
    }

    // 2. Build direct reply history if this message was a reply to the bot
    const chatHistory = [];
    if (referencedMessage) {
      try {
        if (referencedMessage.reference && referencedMessage.reference.messageId) {
          const originalUserMsg = await message.channel.messages.fetch(referencedMessage.reference.messageId).catch(() => null);
          if (originalUserMsg && originalUserMsg.content) {
            const cleanOriginal = botMention ? originalUserMsg.content.replace(botMention, '').trim() : originalUserMsg.content.trim();
            if (cleanOriginal) {
              chatHistory.push({
                role: 'user',
                parts: [{ text: `Question: ${cleanOriginal}` }],
              });
            }
          }
        }

        if (referencedMessage.content) {
          chatHistory.push({
            role: 'model',
            parts: [{ text: referencedMessage.content.trim() }],
          });
        }

        if (chatHistory.length > 0 && chatHistory[0].role === 'model') {
          chatHistory.unshift({
            role: 'user',
            parts: [{ text: 'Question: salam' }],
          });
        }
      } catch (e) {}
    }

    // 3. Assemble prompt with multi-user context
    const callerName = message.member?.displayName || message.author.username;
    let finalPrompt = '';
    if (channelContext) {
      finalPrompt = `Recent channel conversation with multiple users:\n${channelContext}\n\nCurrent message from [${callerName}]:\n${promptText}`;
    } else {
      finalPrompt = `[${callerName}]: ${promptText}`;
    }

    try {
      await message.channel.sendTyping();
      const modelName = await getAvailableGeminiModel();
      console.log(`[AI] Processing query from ${callerName} (${message.author.tag}): "${promptText}" using ${modelName}`);
      
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: `You are "kho Kokiee", a helpful, witty, and powerful Discord community assistant bot.
Reply in casual Moroccan Darija written with Latin letters and familiar chat spelling (Arabizi like "salam cv", "labas", "chno", "sketto", "jbedto"). Never use Arabic script. Keep answers short, usually 1-2 sentences.

MULTI-USER CONVERSATION TRACKING:
You are in a Discord channel where multiple users converse with each other and with you.
When recent channel history is provided in the prompt, use it to track who said what, remember names, understand context across multiple users, and address people by their names when relevant.

You have Discord moderation tools:
- give_role: Call this tool if someone asks to give/assign a role to someone (e.g. "3tih role Member", "give @User role VIP", "3ti role l @User").
- remove_role: Call this tool if someone asks to remove/take away a role from someone (e.g. "7eyed role VIP mn @User", "remove role from @User").
- mute_member: Call this tool if someone asks to mute, silence, or timeout a user (e.g. "sket @user", "mute @user", "sket hada", "kmih @user").
- unmute_member: Call this tool if someone asks to unmute a user (e.g. "telqo @user", "unmute @user", "tle9 l-user").
- move_member: Call this tool if someone asks to pull, move, or bring a user to voice (e.g. "jib @user", "jbed @user", "aji @user", "move @user l voice").
- disconnect_member: Call this tool if someone asks to disconnect or kick someone from voice (e.g. "kherrej @user mn voice", "disconnect @user").
- deafen_member: Call this tool if someone asks to deafen a user in voice (e.g. "sdem @user", "deafen @user").
- undeafen_member: Call this tool if someone asks to undeafen a user in voice (e.g. "7eyed sdem l @user", "undeafen @user").
- create_channel: Call this tool if someone asks to create a channel (e.g. "dir channel smito General", "create a voice channel named Gaming", "sawb channel voice").
- create_role: Call this tool if someone asks to create a role (e.g. "dir role smito VIP", "create role Member", "sawb role Admin").
- move_all_members: Call this tool if someone asks to move EVERYONE in a voice channel to another channel (e.g. "7rekk ga3 li f channel X l channel Y", "move everyone to my channel", "jib ga3 li f l-voice l hna").
- move_members: Call this tool if someone asks to move several specific people to a voice channel (e.g. "jbed @A w @B l hna", "move @A and @B to my channel", "jib @A, @B l voice").
- dm_members: Call this tool if someone asks to send a private message to one or more people (e.g. "sift l @User f privé: salam", "dm @A and @B the rules").
- start_verification: Call this tool if someone asks to verify, or asks to call/tag staff to verify them (e.g. "bghit nverify", "3ayet l staff yverify-iw", "call staff to verify me").
- play_music: Call this tool if someone asks to play a song/music (e.g. "play some chill music", "3zef chi song", "diro chi 7aja"). You type the Jockie Music command in chat.
- skip_music: Call this tool if someone asks to skip the song (e.g. "skip", "dozi l-li moraha").
- stop_music: Call this tool if someone asks to stop the music (e.g. "stop l-music", "w9ef l-music").
- leave_music: Call this tool if someone asks to make the music bot leave the voice channel (e.g. "kherrej Jockie", "leave voice").
- delete_channel: Call this tool if someone asks to delete a channel (e.g. "ms7 channel X", "delete channel #general", "7eyed channel smito Y").
- delete_role: Call this tool if someone asks to delete a role (e.g. "ms7 role VIP", "delete role Member", "7eyed role smito X").

MULTI-STEP TASKS:
You can perform several actions in a single request. When the user asks for multiple things at once (e.g. "disconnect @user, then create a voice channel, then mute @user"), call the needed tools one after another. After each tool result, decide whether another tool is still needed and call it. Only give the final Darija summary once ALL requested actions are done.

For regular chit-chat, answer questions directly in Moroccan Darija without calling tools.
When all tools have returned, summarize every successful action happily in 1-2 short Moroccan Darija sentences. If any action failed or was not allowed, return no text at all (stay completely silent).`,
        tools: discordTools,
      });

      const chat = model.startChat({
        history: chatHistory.length > 0 ? chatHistory : undefined,
        generationConfig: {
          maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
          temperature: 0.7,
          ...(modelName.includes('3.8') ? { thinkingConfig: { thinkingLevel: 'low' } } : {}),
        },
      });

      let result = await chat.sendMessage(finalPrompt);
      let responseText = '';

      const MAX_TOOL_ROUNDS = 6;
      const executedTools = []; // { name, result } for fallback summary

      // Loop to support chained multi-step tasks: keep executing tool calls until
      // the model stops requesting them (e.g. "disconnect @user, create a channel, mute them")
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const functionCalls = result.response.functionCalls();
        if (!functionCalls || functionCalls.length === 0) {
          responseText = extractResponseText(result.response);
          break;
        }

        // Execute every tool the model requested this round
        const functionResponses = [];
        for (const call of functionCalls) {
          console.log(`[AI Tool] Model requested ${call.name} with args:`, call.args);
          const toolResult = await executeDiscordTool(call.name, call.args, message);
          console.log(`[AI Tool] Execution result:`, toolResult);
          executedTools.push({ name: call.name, result: toolResult });
          functionResponses.push({
            functionResponse: {
              name: call.name,
              response: toolResult,
            },
          });
        }

        result = await chat.sendMessage(functionResponses);
        responseText = extractResponseText(result.response);
      }

      // If any requested action failed, stay silent (send nothing to chat) — just log it
      const failedTools = executedTools.filter(t => t.result && t.result.success === false);
      if (failedTools.length > 0) {
        console.warn(`[AI] Action(s) failed, staying silent:`, failedTools.map(f => `${f.name}: ${f.result.error}`).join(' | '));
        await sendLog(message.guild, `⚠️ **AI Action Failed (silent):** <@${message.author.id}> — ${failedTools.map(f => `\`${f.name}\`: ${f.result.error}`).join(' | ')}`);
        return;
      }

      // Fallback: if Gemini produced no final text, build a Darija summary of executed tools
      if (!responseText && executedTools.length > 0) {
        responseText = executedTools.map(({ name, result: r }) => {
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
            case 'play_music': return `Safi 3tit l Jockie bach yplayi \`${r.query}\` 🎶`;
            case 'skip_music': return `Safi skipt l-ghnya ⏭️`;
            case 'stop_music': return `Safi w9eft l-music ⏹️`;
            case 'leave_music': return `Safi kherrejt Jockie mn l voice 👋`;
            case 'delete_channel': return `Safi ms7t channel \`${r.name}\` 🗑️`;
            case 'delete_role': return `Safi ms7t role \`${r.name}\` 🗑️`;
            default: return `Safi t-dar l-action **${name}** ✅`;
          }
        }).join('\n');
      }

      if (!responseText) throw new Error('Gemini returned an empty response');
      if (responseText.length > 2000) responseText = responseText.substring(0, 1996) + '...';

      console.log(`[AI] Successfully generated reply (${responseText.length} chars)`);
      await message.reply(responseText).catch(async (replyErr) => {
        console.warn(`[AI] message.reply failed (${replyErr.message}), falling back to channel.send...`);
        return message.channel.send(responseText);
      });

      await sendLog(message.guild, `🤖 **AI Query:** <@${message.author.id}> mentioned the AI in <#${message.channel.id}>.`);
    } catch (err) {
      console.error(`Gemini API Error: ${err.message}`);
      if (err.message && err.message.includes('404')) {
        activeGeminiModel = null;
      }
      aiUserCooldowns.delete(message.author.id);
      // Stay silent on errors — send nothing to chat (log only)
    }
    return;
  }
  // A. AJI COMMAND: aji @user
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

  // B. BROADCAST / SAY COMMAND: .say <message>
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

  // C. VOICE ROOM CONTROL COMMANDS: .a ...
  if (!message.content.startsWith('.a')) return;
  const args = message.content.slice(2).trim().split(/ +/);
  const command = args.shift().toLowerCase();
  const voiceChannel = message.member?.voice?.channel;
  
  if (!voiceChannel) return message.reply('❌ You must be connected to a voice channel to use room commands.');

  // CLAIM COMMAND
  if (command === 'claim') {
    const currentOwner = roomOwners.get(voiceChannel.id);
    if (currentOwner && currentOwner !== message.author.id) {
      return message.reply('❌ This room is already actively owned by someone else in this session.');
    }
    try {
      roomOwners.set(voiceChannel.id, message.author.id);
      await voiceChannel.permissionOverwrites.edit(message.author.id, { ManageChannels: true, Connect: true, Speak: true, SendMessages: true, ReadMessageHistory: true });
      await sendLog(message.guild, `🔑 **Room Claimed:** <@${message.author.id}> reclaimed ownership of \`${voiceChannel.name}\`.`);
      return message.reply('✅ You have successfully reclaimed ownership of this room! You can use `.a` commands again.');
    } catch (err) {
      return message.reply('❌ An error occurred while trying to claim the room.');
    }
  }

  // Verify ownership for other commands
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
    } 
    else if (command === 'lock') {
      await voiceChannel.permissionOverwrites.edit(message.guild.id, { Connect: false });
      await message.reply('🔒 Room locked.');
    } 
    else if (command === 'unlock') {
      await voiceChannel.permissionOverwrites.edit(message.guild.id, { Connect: null });
      await message.reply('🔓 Room unlocked.');
    } 
    else if (command === 'limit') {
      const limit = parseInt(args[0], 10);
      if (isNaN(limit) || limit < 0 || limit > 99) return message.reply('❌ Please provide a valid number between 0 and 99.');
      await voiceChannel.setUserLimit(limit);
      await message.reply(limit === 0 ? '✅ Room user limit removed.' : `✅ Room limit set to **${limit}** users.`);
    }
    else if (command === 'add' || command === 'permit') {
      const targetUser = message.mentions.users.first();
      if (!targetUser) return message.reply('❌ Please mention a user to add.');
      await voiceChannel.permissionOverwrites.edit(targetUser.id, { Connect: true, ViewChannel: true, Speak: true });
      await message.reply(`✅ Added ${targetUser} to your room.`);
    } 
    else if (command === 'reject') {
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
