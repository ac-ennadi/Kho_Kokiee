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

// AI Setup
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
let genAI;
if (GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
}

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

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}! Bot is online and ready.`);
  if (!GEMINI_API_KEY) console.log("⚠️ GEMINI_API_KEY is missing. The .ask command will be disabled.");
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

// 4. Handle Messages & Commands
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  // AI INTEGRATION WITH PERSONA: .ask command
  if (message.content.startsWith('.ask ')) {
    if (!genAI) {
      return message.reply('❌ AI is not configured. The owner needs to set `GEMINI_API_KEY`.');
    }

    const promptText = message.content.slice(5).trim();
    if (!promptText) return message.reply('❌ Please provide a question. Example: `.ask How do I get verified?`');

    try {
      await message.channel.sendTyping();

      const model = genAI.getGenerativeModel({ 
        model: 'gemini-3.8-flash',
        systemInstruction: `You are a helpful, polite, and intelligent staff bot member of this Discord server. 
Your goal is to assist members, answer their questions clearly, and guide them if they need help. 
Always be friendly and professional. Use Discord markdown formatting like bolding or bullet points when useful. 
Keep your answers concise, as Discord has a character limit.`
      });

      const fullPrompt = `The user talking to you is named ${message.member.displayName}. They are asking: ${promptText}`;

      const result = await model.generateContent(fullPrompt);
      let responseText = result.response.text();

      if (responseText.length > 2000) {
        responseText = responseText.substring(0, 1996) + '...';
      }

      await message.reply(responseText);
      await sendLog(message.guild, `🤖 **AI Query:** <@${message.author.id}> asked the AI a question in <#${message.channel.id}>.`);
    } catch (err) {
      console.error(`AI API Error: ${err.message}`);
      message.reply(`❌ AI Error: \`${err.message}\``);
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

  // C. VOICE ROOM CONTROL COMMANDS: .a ... (Changed from .v)
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