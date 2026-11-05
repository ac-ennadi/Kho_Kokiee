const { Client, GatewayIntentBits, ActivityType, ChannelType, PermissionsBitField } = require('discord.js');

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
const CATEGORY_ID = process.env.CATEGORY_ID || null;                  
const CREATE_VC_ID = process.env.CREATE_VC_ID;                        
const CREATE_CATEGORY_ID = process.env.CREATE_CATEGORY_ID || null;    

// In-memory tracker to remember who owns which custom voice channel { channelId: userId }
const roomOwners = new Map();

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}! Bot is online and ready.`);
});

// 1. Assign role when a new member joins the server
client.on('guildMemberAdd', async (member) => {
  try {
    const role = member.guild.roles.cache.get(ROLE_ID);
    if (!role) {
      console.error('Role not found. Check your ROLE_ID.');
      return;
    }
    await member.roles.add(role);
    console.log(`Assigned ${role.name} to ${member.user.tag}`);
  } catch (error) {
    console.error(`Failed to assign role: ${error.message}`);
  }
});

// 2. Handle voice channel workflows (Verification, Custom J2C, and Cleanup)
client.on('voiceStateUpdate', async (oldState, newState) => {
  if (oldState.channel) {
    const channel = oldState.channel;
    const isVerifyChannel = channel.name.startsWith('verify-');
    const isCustomRoom = roomOwners.has(channel.id);

    if ((isVerifyChannel || isCustomRoom) && channel.members.size === 0) {
      try {
        roomOwners.delete(channel.id);
        await channel.delete();
        console.log(`Deleted empty temporary channel: ${channel.name}`);
      } catch (err) {
        console.error(`Failed to delete empty channel: ${err.message}`);
      }
    }
  }

  if (CREATE_VC_ID && newState.channelId === CREATE_VC_ID && oldState.channelId !== CREATE_VC_ID) {
    const member = newState.member;
    try {
      const guild = newState.guild;

      const customChannel = await guild.channels.create({
        name: `🔊 ${member.user.username}'s Room`,
        type: ChannelType.GuildVoice,
        parent: CREATE_CATEGORY_ID && CREATE_CATEGORY_ID.length > 5 ? CREATE_CATEGORY_ID : null,
        permissionOverwrites: [
          {
            id: member.id,
            allow: [PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory],
          }
        ]
      });

      roomOwners.set(customChannel.id, member.id);

      await member.voice.setChannel(customChannel);
      console.log(`Created custom voice channel ${customChannel.name} and moved ${member.user.tag}`);

      setTimeout(async () => {
        try {
          await customChannel.send(
            `👋 Welcome to your custom room, <@${member.id}>!\n` +
            `Here are the commands you can use to control your channel:\n` +
            `• \`.v name <new name>\` - Rename your room\n` +
            `• \`.v lock\` - Lock your room so no one else can join\n` +
            `• \`.v unlock\` - Unlock your room\n` +
            `• \`.v add @User\` (or \`.v permit @User\`) - Allow a specific user to join\n` +
            `• \`.v reject @User\` - Block and kick a user from your room`
          );
        } catch (err) {
          console.error(`Failed to send guide message in custom room: ${err.message}`);
        }
      }, 1000);

    } catch (error) {
      console.error(`Failed to create custom voice channel: ${error.message}`);
    }
  }

  if (newState.channelId === TARGET_VC_ID && oldState.channelId !== TARGET_VC_ID) {
    const member = newState.member;

    if (!member.roles.cache.has(NOT_VERIFIED_ROLE_ID)) {
      console.log(`[VoiceUpdate] User ${member.user.tag} joined target VC, but does NOT have the unverified role.`);
      return;
    }

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
        name: `verify-${member.user.username}`,
        type: ChannelType.GuildVoice,
        parent: CATEGORY_ID && CATEGORY_ID.length > 5 ? CATEGORY_ID : null,
        permissionOverwrites: overwrites,
      });

      await member.voice.setChannel(newChannel);

      if (STAFF_ROLE_ID) {
        setTimeout(async () => {
          try {
            await newChannel.send(`<@&${STAFF_ROLE_ID}> New verification session started for **${member.user.tag}**. Please assist them here!`);
          } catch (err) {}
        }, 1000);
      }
    } catch (error) {
      console.error(`Failed to create verification voice channel: ${error.message}`);
    }
  }
});

// 3. Handle Messages & Commands
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  // A. BROADCAST / SAY COMMAND: .say <message> (Restricted to Staff Role)
  if (message.content.startsWith('.say ')) {
    // Check if the user has the staff role (or is a server Administrator)
    const hasStaffRole = STAFF_ROLE_ID && message.member.roles.cache.has(STAFF_ROLE_ID);
    const isAdmin = message.member.permissions.has(PermissionsBitField.Flags.Administrator);

    if (!hasStaffRole && !isAdmin) {
      return message.reply('❌ You do not have permission to use the `.say` command.').then(msg => {
        setTimeout(() => msg.delete().catch(() => {}), 5000);
      });
    }

    const broadcastText = message.content.slice(5).trim();
    if (!broadcastText) return;

    try {
      await message.delete(); // Delete command message
      await message.channel.send(broadcastText); // Send broadcast as bot
    } catch (err) {
      console.error(`Say command error: ${err.message}`);
    }
    return;
  }

  // B. VOICE ROOM CONTROL COMMANDS: .v ...
  if (!message.content.startsWith('.v')) return;

  const args = message.content.slice(2).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) {
    return message.reply('❌ You must be connected to a voice channel to use room commands.');
  }

  const ownerId = roomOwners.get(voiceChannel.id);
  if (!ownerId || ownerId !== message.author.id) {
    return message.reply('❌ You can only manage a custom voice channel that you created!');
  }

  try {
    if (command === 'name') {
      const newName = args.join(' ');
      if (!newName) return message.reply('❌ Please provide a new name. Example: `.v name Chill Lounge`');
      await voiceChannel.setName(`🔊 ${newName}`);
      await message.reply(`✅ Room renamed to **🔊 ${newName}**`);
    } 
    else if (command === 'lock') {
      await voiceChannel.permissionOverwrites.edit(message.guild.id, { Connect: false });
      await message.reply('🔒 Room locked. Non-permitted users can no longer join.');
    } 
    else if (command === 'unlock') {
      await voiceChannel.permissionOverwrites.edit(message.guild.id, { Connect: null });
      await message.reply('🔓 Room unlocked. Everyone can join again.');
    } 
    else if (command === 'add' || command === 'permit') {
      const targetUser = message.mentions.users.first();
      if (!targetUser) return message.reply('❌ Please mention a user to add. Example: `.v add @Username`');
      
      await voiceChannel.permissionOverwrites.edit(targetUser.id, { Connect: true, ViewChannel: true, Speak: true });
      await message.reply(`✅ Added ${targetUser} to your room.`);
    } 
    else if (command === 'reject') {
      const targetUser = message.mentions.users.first();
      if (!targetUser) return message.reply('❌ Please mention a user to reject. Example: `.v reject @Username`');

      await voiceChannel.permissionOverwrites.edit(targetUser.id, { Connect: false });
      
      const targetMember = await message.guild.members.fetch(targetUser.id).catch(() => null);
      if (targetMember && targetMember.voice.channelId === voiceChannel.id) {
        await targetMember.voice.disconnect();
      }

      await message.reply(`🚫 Rejected ${targetUser} from users who can enter.`);
    }
  } catch (err) {
    console.error(`Command error: ${err.message}`);
    message.reply('❌ An error occurred while executing that command.');
  }
});

console.log("DEBUG TOKEN CHECK:", process.env.DISCORD_TOKEN ? `Loaded (${process.env.DISCORD_TOKEN.length} chars)` : "MISSING/UNDEFINED");

client.login(process.env.DISCORD_TOKEN);