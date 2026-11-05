const { Client, GatewayIntentBits, ActivityType, ChannelType, PermissionsBitField } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
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
const CREATE_VC_ID = process.env.CREATE_VC_ID; // New: Hub channel ID for Join-to-Create

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
  // A. CLEANUP: Check if someone left a temporary verification channel or custom room and it's now empty
  if (oldState.channel && (oldState.channel.name.startsWith('verify-') || oldState.channel.name.includes("'s Room"))) {
    const channel = oldState.channel;
    if (channel.members.size === 0) {
      try {
        await channel.delete();
        console.log(`Deleted empty temporary channel: ${channel.name}`);
      } catch (err) {
        console.error(`Failed to delete empty channel: ${err.message}`);
      }
    }
  }

  // B. JOIN TO CREATE: Check if the user joined the "Create Channel" hub
  if (CREATE_VC_ID && newState.channelId === CREATE_VC_ID && oldState.channelId !== CREATE_VC_ID) {
    const member = newState.member;
    try {
      const guild = newState.guild;

      // Create a personalized voice channel for the member
      const customChannel = await guild.channels.create({
        name: `🔊 ${member.user.username}'s Room`,
        type: ChannelType.GuildVoice,
        parent: CATEGORY_ID && CATEGORY_ID.length > 5 ? CATEGORY_ID : null,
      });

      // Move the user into their newly created custom channel
      await member.voice.setChannel(customChannel);
      console.log(`Created custom voice channel ${customChannel.name} and moved ${member.user.tag}`);
    } catch (error) {
      console.error(`Failed to create custom voice channel: ${error.message}`);
    }
  }

  // C. VERIFICATION WORKFLOW: Check if the user joined the specific verification voice channel
  if (newState.channelId === TARGET_VC_ID && oldState.channelId !== TARGET_VC_ID) {
    const member = newState.member;

    // Check if the user has the "not verified" role
    if (!member.roles.cache.has(NOT_VERIFIED_ROLE_ID)) {
      console.log(`[VoiceUpdate] User ${member.user.tag} joined target VC, but does NOT have the unverified role.`);
      return;
    }

    console.log(`[VoiceUpdate] SUCCESS: User has the unverified role! Creating channel...`);

    try {
      const guild = newState.guild;

      // Base overwrites for @everyone and the joining user
      const overwrites = [
        {
          id: guild.id, 
          deny: [PermissionsBitField.Flags.ViewChannel],
        },
        {
          id: member.id, 
          allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak],
        },
      ];

      // Safely verify if the staff role exists in the guild cache before adding it
      let staffRoleMention = '';
      if (STAFF_ROLE_ID) {
        const staffRole = guild.roles.cache.get(STAFF_ROLE_ID);
        if (staffRole) {
          overwrites.push({
            id: staffRole.id,
            allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory],
          });
          staffRoleMention = `<@&${staffRole.id}>`;
        } else {
          console.log(`[Warning] STAFF_ROLE_ID (${STAFF_ROLE_ID}) was not found in guild roles cache.`);
        }
      }

      // Create the new voice channel named after the user
      const newChannel = await guild.channels.create({
        name: `verify-${member.user.username}`,
        type: ChannelType.GuildVoice,
        parent: CATEGORY_ID && CATEGORY_ID.length > 5 ? CATEGORY_ID : null,
        permissionOverwrites: overwrites,
      });

      // Move the user into the newly created voice channel
      await member.voice.setChannel(newChannel);
      console.log(`Created verification channel ${newChannel.name} and moved ${member.user.tag}`);

      // Send the staff ping directly inside the new voice channel's built-in text chat
      if (staffRoleMention) {
        setTimeout(async () => {
          try {
            await newChannel.send(`${staffRoleMention} New verification session started for **${member.user.tag}**. Please assist them here!`);
            console.log(`Sent staff notification inside the voice channel text chat.`);
          } catch (err) {
            console.error(`Failed to send message in voice channel text chat: ${err.message}`);
          }
        }, 1000);
      }

    } catch (error) {
      console.error(`Failed to create verification voice channel: ${error.message}`);
    }
  }
});

console.log("DEBUG TOKEN CHECK:", process.env.DISCORD_TOKEN ? `Loaded (${process.env.DISCORD_TOKEN.length} chars)` : "MISSING/UNDEFINED");

client.login(process.env.DISCORD_TOKEN);