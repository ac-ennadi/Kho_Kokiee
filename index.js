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

      // Prioritized list of active free-tier models (newest stable first)
      const priority = [
        'gemini-2.0-flash-lite', 'gemini-2.0-flash',
        'gemini-1.5-flash-8b', 'gemini-1.5-flash-latest', 'gemini-1.5-flash-002', 'gemini-1.5-flash-001',
        'gemini-flash-2.0-lite', 'gemini-flash',
      ];
      for (const pref of priority) {
        if (models.includes(pref)) {
          activeGeminiModel = pref;
          console.log(`🤖 Auto-selected Gemini model: ${activeGeminiModel}`);
          return activeGeminiModel;
        }
      }

      // Skip deprecated 2.5/1.5-flash (removed for new users), prefer 2.0 family
      const anyFlash = models.find(m => {
        const lower = m.toLowerCase();
        return lower.includes('flash') && !lower.includes('2.5') && !lower.includes('1.5-flash:');
      });
      if (anyFlash) {
        activeGeminiModel = anyFlash;
        console.log(`🤖 Auto-selected flash model: ${activeGeminiModel}`);
        return activeGeminiModel;
      }

      // Last resort: any flash at all
      const lastResortFlash = models.find(m => m.toLowerCase().includes('flash'));
      if (lastResortFlash) {
        activeGeminiModel = lastResortFlash;
        console.log(`🤖 Last-resort flash model: ${activeGeminiModel}`);
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
    const isCustomRoom = roomOwners.has(channel.id) || channel.name.includes("'s Room");

    if ((isVerifyChannel || isCustomRoom) && channel.members.size === 0) {
      try {
        roomOwners.delete(channel.id);
        await channel.delete();
        await sendLog(channel.guild, `🗑️ **Room Deleted:** Auto-deleted empty temporary channel \`${channel.name}\`.`);
      } catch (err) {}
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
  if (newState.channelId === TARGET_VC_ID && oldState.channelId !== TARGET_VC_ID) {
    const member = newState.member;
    if (!member.roles.cache.has(NOT_VERIFIED_ROLE_ID)) return;

    try {
      const guild = newState.guild;
      const overwrites = [
        { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: member.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak] },
      ];

      if (STAFF_ROLE_ID) {
        const staffRole = guild.roles.cache.get(STAFF_ROLE_ID);
        if (staffRole) {
          overwrites.push({
            id: staffRole.id,
            allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory],
          });
        }
      }

      const newChannel = await guild.channels.create({
        name: `verify-${member.displayName}`,
        type: ChannelType.GuildVoice,
        parent: (CATEGORY_ID && CATEGORY_ID.length > 5) ? CATEGORY_ID : null,
        permissionOverwrites: overwrites,
      });

      await member.voice.setChannel(newChannel);
      await sendLog(guild, `🛡️ **Verification Session:** <@${member.id}> started a verification session in \`${newChannel.name}\`.`);

      if (STAFF_ROLE_ID) {
        setTimeout(async () => {
          try {
            await newChannel.send(`<@&${STAFF_ROLE_ID}> New verification session started for **${member.displayName}**. Please assist them here!`);
          } catch (err) {}
        }, 1000);
      }
    } catch (error) {}
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
        name: 'move_multiple_members',
        description: 'Moves multiple users to a voice channel at once. Use when asked to move several people, e.g. "movi @X o @Y l voice", "jib @X o @Z hna", "move X and Y to channel".',
        parameters: {
          type: 'OBJECT',
          properties: {
            target_users: {
              type: 'STRING',
              description: 'Comma-separated list of usernames, mentions, or display names (e.g. "@Alice, @Bob, zenin")',
            },
            destination: {
              type: 'STRING',
              description: 'Target voice channel name, here for caller channel, or a username whose current voice channel to use as destination',
            },
          },
          required: ['target_users'],
        },
      },
    ],
  },
];

// Helper to find a role by name, mention, or ID
function findRole(guild, roleQuery) {
  if (!roleQuery) return null;
  const clean = roleQuery.replace(/^[<@&>#\s]+/, '').trim().toLowerCase();

  if (/^\d{17,20}$/.test(clean)) {
    const role = guild.roles.cache.get(clean);
    if (role) return role;
  }

  let matched = guild.roles.cache.find(r => r.name.toLowerCase() === clean);
  if (matched) return matched;

  matched = guild.roles.cache.find(r => r.name.toLowerCase().includes(clean));
  return matched || null;
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
  const targetMember = await findTargetMember(message.guild, args.target_user, message.mentions, message.client.user.id);

  if (!targetMember) {
    return {
      success: false,
      error: `Could not find any user matching "${args.target_user}". Ask caller to mention them like @Username.`,
    };
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
        error: `${targetMember.displayName} is not in any voice channel right now. Tell caller in Moroccan Darija that the user must be in voice.`,
      };
    }

    let destinationChannel = caller.voice.channel;
    if (args.destination && args.destination.toLowerCase() !== 'me' && args.destination.toLowerCase() !== 'here' && args.destination.toLowerCase() !== 'hna') {
      const cleanDest = args.destination.toLowerCase().replace(/^[#🔊\s]+/, '').trim();

      // Try destination by mentioned user (e.g. "l tap dyal @AYA")
      const destUserMention = args.destination.match(/<@!?(\d{17,20})>/);
      if (destUserMention) {
        const destMember = await message.guild.members.fetch(destUserMention[1]).catch(() => null);
        if (destMember && destMember.voice.channel) {
          destinationChannel = destMember.voice.channel;
        }
      } else {
        // Try matching a member by name in the destination string (e.g. "dyal aya")
        const words = cleanDest.split(/\s+/);
        let foundByUser = null;
        for (const word of words) {
          if (word.length < 2 || ['dyal', 'tap', 'l', 'le', 'la', 'fi', 'f'].includes(word)) continue;
          try {
            const searched = await message.guild.members.fetch({ query: word, limit: 3 });
            const match = searched.find(m => m.id !== message.author.id && m.id !== targetMember.id && m.voice && m.voice.channel);
            if (match) { foundByUser = match.voice.channel; break; }
          } catch (e) {}
        }
        if (foundByUser) {
          destinationChannel = foundByUser;
        } else {
          // Fall back to named voice channel
          const found = message.guild.channels.cache.find(
            c => c.isVoiceBased() && (c.id === cleanDest || c.name.toLowerCase().includes(cleanDest))
          );
          if (found) destinationChannel = found;
        }
      }
    }

    if (!destinationChannel) {
      return {
        success: false,
        error: `Caller ${caller.displayName} is not connected to any voice channel and no valid target channel was found. Tell them to join a voice channel first.`,
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

  // 5b. MOVE MULTIPLE MEMBERS
  if (name === 'move_multiple_members') {
    if (!canCallerMove(caller)) {
      return {
        success: false,
        error: `Permission denied: ${caller.displayName} does not have permission to move members.`,
      };
    }

    const rawUsers = args.target_users || '';
    // Split by comma, " o ", " and ", " w " (Darija "and")
    const userTokens = rawUsers.split(/,|\s+o\s+|\s+and\s+|\s+w\s+/i).map(s => s.trim()).filter(Boolean);

    if (userTokens.length === 0) {
      return { success: false, error: 'No users specified for bulk move.' };
    }

    // Resolve destination channel
    let destChannel = caller.voice.channel;
    const destArg = args.destination || '';
    if (destArg && !['here', 'me', 'hna'].includes(destArg.toLowerCase().trim())) {
      const cleanDest = destArg.toLowerCase().replace(/^[#🔊\s]+/, '').trim();
      const destUserMention = destArg.match(/<@!?(\d{17,20})>/);
      if (destUserMention) {
        const destMember = await message.guild.members.fetch(destUserMention[1]).catch(() => null);
        if (destMember && destMember.voice.channel) destChannel = destMember.voice.channel;
      } else {
        const words = cleanDest.split(/\s+/);
        let foundByUser = null;
        for (const word of words) {
          if (word.length < 2 || ['dyal', 'tap', 'l', 'le', 'la', 'fi', 'f'].includes(word)) continue;
          try {
            const searched = await message.guild.members.fetch({ query: word, limit: 3 });
            const match = searched.find(m => m.id !== message.author.id && m.voice && m.voice.channel);
            if (match) { foundByUser = match.voice.channel; break; }
          } catch (e) {}
        }
        if (foundByUser) {
          destChannel = foundByUser;
        } else {
          const found = message.guild.channels.cache.find(
            c => c.isVoiceBased() && (c.id === cleanDest || c.name.toLowerCase().includes(cleanDest))
          );
          if (found) destChannel = found;
        }
      }
    }

    if (!destChannel) {
      return { success: false, error: `No valid destination found and caller ${caller.displayName} is not in voice.` };
    }

    // Resolve each user and move them
    const moveResults = [];
    await Promise.allSettled(userTokens.map(async (token) => {
      try {
        const member = await findTargetMember(message.guild, token, message.mentions, message.client.user.id);
        if (!member) {
          moveResults.push({ token, success: false, error: `User not found: ${token}` });
          return;
        }
        if (!member.voice || !member.voice.channel) {
          moveResults.push({ token, success: false, error: `${member.displayName} is not in voice` });
          return;
        }
        await member.voice.setChannel(destChannel);
        await sendLog(message.guild, `🧲 **AI Bulk Move:** <@${caller.id}> moved <@${member.id}> to \`${destChannel.name}\`.`);
        moveResults.push({ token, success: true, user: member.displayName, mention: `<@${member.id}>` });
      } catch (err) {
        moveResults.push({ token, success: false, error: err.message });
      }
    }));

    const succeeded = moveResults.filter(r => r.success);
    const failed = moveResults.filter(r => !r.success);
    return {
      success: succeeded.length > 0,
      moved: succeeded.map(r => r.mention || r.user).join(', '),
      movedCount: succeeded.length,
      failed: failed.map(r => `${r.token}: ${r.error}`).join('; '),
      failedCount: failed.length,
      channel: destChannel.name,
    };
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
Reply in casual Moroccan Darija written with Latin letters and familiar chat spelling (Arabizi like "salam cv", "labas", "chno", "sketto", "jbedto"). Never use Arabic script. Keep answers short, usually 1-3 sentences.

MULTI-USER CONVERSATION TRACKING:
You are in a Discord channel where multiple users converse with each other and with you.
When recent channel history is provided in the prompt, use it to track who said what, remember names, understand context across multiple users, and address people by their names when relevant.

COMMAND PARSING (Moroccan Darija / Arabizi):
- "muter @X", "sket @X", "kmih @X", "mute @X", "sketh" → use mute_member tool
- "movi @X", "move @X", "jib @X", "jbed @X", "aji @X" → use move_member tool
- "movi @X l tap dyal @Y" → use move_member with target_user=@X and destination=@Y (move X to Y's current voice channel)
- "movi @X o @Y" or "jib @X o @Z" (multiple targets, o=and in Darija) → use move_multiple_members
- "3tih role X", "give @X role Y", "3ti role l @X" → use give_role tool
- "7eyed role X mn @Y", "remove role from @Y" → use remove_role tool
- "telqo @X", "unmute @X", "tle9 @X" → use unmute_member tool
- "kherrej @X mn voice", "disconnect @X" → use disconnect_member tool
- "sdem @X", "deafen @X" → use deafen_member tool
- "7eyed sdem l @X", "undeafen @X" → use undeafen_member tool

PERMISSIONS: Staff role members, admins, and owners can use moderation tools. If the caller lacks permission, explain clearly in Moroccan Darija WHY (not a generic error).

TOOL RESULTS:
When a tool returns success: Confirm the action with a short happy Darija message.
When a tool returns failure, explain the ACTUAL problem in Moroccan Darija clearly:
- Not in voice: "X machi f ay voice channel daba. Khasso ykun f voice bash yetmute/yetmovi."
- No permission: "Ma 3endekch s-salahiya, ghir staff o admins yqdro."
- Not found: "Ma lqitch dak l-user, 3awel mentioniw b @Username."
- Role too high: "Role dyalu f9 mn role dyali, ma qdertch n-managiha."

For regular chit-chat, answer questions directly in Moroccan Darija without calling tools.`,
        tools: discordTools,
      });

      const chatConfig = {
        history: chatHistory.length > 0 ? chatHistory : undefined,
        generationConfig: {
          maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
          temperature: 0.7,
        },
      };
      // Note: thinkingConfig only applies to experimental thinking models (2.5+)
      // For stable 2.0 flash models, skip it entirely to avoid 400 errors
      const chat = model.startChat(chatConfig);

      let result = await chat.sendMessage(finalPrompt);
      let responseText = '';

      const functionCalls = result.response.functionCalls();
      if (functionCalls && functionCalls.length > 0) {
        const call = functionCalls[0];
        console.log(`[AI Tool] Model requested ${call.name} with args:`, call.args);

        const toolResult = await executeDiscordTool(call.name, call.args, message);
        console.log(`[AI Tool] Execution result:`, toolResult);

        const followUp = await chat.sendMessage([
          {
            functionResponse: {
              name: call.name,
              response: toolResult,
            },
          },
        ]);

        try {
          responseText = followUp.response.text()?.trim();
        } catch (e) {
          console.warn(`[AI] followUp text() warning: ${e.message}`);
        }

        if (!responseText && toolResult.success) {
          if (call.name === 'give_role') responseText = `Safi a khay, 3tit role **${toolResult.role}** l ${toolResult.mention || toolResult.user} ✅`;
          else if (call.name === 'remove_role') responseText = `Safi 7eyedt role **${toolResult.role}** mn ${toolResult.mention || toolResult.user} ✅`;
          else if (call.name === 'mute_member') responseText = `Safi a khay, sket ${toolResult.mention || toolResult.user} f l-voice 🔇`;
          else if (call.name === 'unmute_member') responseText = `Safi telqt ${toolResult.mention || toolResult.user} ✅`;
          else if (call.name === 'move_member') responseText = `Hani jbedt ${toolResult.mention || toolResult.user} l ${toolResult.channel} 😉`;
          else if (call.name === 'move_multiple_members') {
            let txt = `Safi jbedt ${toolResult.moved} l ${toolResult.channel} ✅`;
            if (toolResult.failedCount > 0) txt += ` (Ma qdertch njbed: ${toolResult.failed})`;
            responseText = txt;
          }
          else if (call.name === 'disconnect_member') responseText = `Safi kherrejt ${toolResult.mention || toolResult.user} mn l voice 🚪`;
          else if (call.name === 'deafen_member') responseText = `Safi sdemt ${toolResult.mention || toolResult.user} f voice 🔇`;
          else if (call.name === 'undeafen_member') responseText = `Safi 7eyedt sdem l ${toolResult.mention || toolResult.user} 🔊`;
        } else if (!responseText && !toolResult.success) {
          // Give specific Darija error based on actual error message
          const errMsg = toolResult.error || '';
          if (errMsg.includes('not connected') || errMsg.includes('not in any voice')) {
            const name = errMsg.split(' ')[0] || 'User';
            responseText = `${name} machi f ay voice channel daba — khasso ykun f voice bash ndir had l-action.`;
          } else if (errMsg.includes('Permission denied') || errMsg.includes('does not have')) {
            responseText = 'Ma 3endekch s-salahiya bach dir had l-action. Ghir l-staff o l-admins yqdro 🙏';
          } else if (errMsg.includes('not found') || errMsg.includes('Could not find')) {
            responseText = 'Ma lqitch dak l-user. 3awel mentioniw b @Username 👀';
          } else if (errMsg.includes('higher than') || errMsg.includes('hierarchy')) {
            responseText = 'Ma qdertch n-managih — role dyalu f9 mn role dyali. Kallem l-admin yrfe3 role dyali 🙏';
          } else if (errMsg.includes('Administrator')) {
            responseText = 'Ma ymkench nmute l-admin 😅';
          } else {
            responseText = `W9e3 mochkil: ${errMsg.substring(0, 180)}`;
          }
        }
      } else {
        try {
          responseText = result.response.text()?.trim();
        } catch (textErr) {
          console.warn(`[AI] response.text() warning: ${textErr.message}`);
        }

        if (!responseText) {
          const parts = result.response?.candidates?.[0]?.content?.parts || [];
          const nonThought = parts.filter(p => !p.thought && p.text);
          if (nonThought.length > 0) {
            responseText = nonThought.map(p => p.text).join('\n').trim();
          } else {
            responseText = parts.map(p => p.text).filter(Boolean).join('\n').trim();
          }
        }
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
      aiUserCooldowns.delete(message.author.id);

      let userErrorMsg = 'W9e3 mochkil w ana kanwjed lik ljawab. 3awed jereb mn b3d chwia 🙏';

      if (err.message) {
        if (err.message.includes('404') || err.message.includes('not found')) {
          activeGeminiModel = null; // Force model re-detection next time
          userErrorMsg = 'Mochkil m3a l-AI model — ghadi n-detectih mn jdid. 3awed jereb 🙏';
        } else if (err.message.includes('429') || err.message.includes('quota') || err.message.includes('RESOURCE_EXHAUSTED')) {
          userErrorMsg = 'Wslna l-7add l-AI dyal l-yom (quota). 3awed jereb f l-sa3a jaya ⏳';
        } else if (err.message.includes('400') || err.message.includes('INVALID_ARGUMENT')) {
          userErrorMsg = 'Mochkil f l-tlab (bad request). 7awel tkteb sou2al kher 🙏';
        } else if (err.message.includes('503') || err.message.includes('unavailable') || err.message.includes('overloaded')) {
          userErrorMsg = 'AI server m7mool daba, 3awed jereb b3d chwia ⏳';
        } else if (err.message.includes('empty response') || err.message.includes('Empty')) {
          userErrorMsg = 'AI ma jawbch (jawab khawi). 3awed jereb 🙏';
        }
      }

      await message.reply(userErrorMsg).catch(async () => {
        await message.channel.send(userErrorMsg).catch(() => {});
      });
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
