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

client.once('ready', () => {
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

// 2. Handle voice channel verification workflow
client.on('voiceStateUpdate', async (oldState, newState) => {
  console.log(`[VoiceUpdate] User ${newState.member?.user.tag} moved from channel ${oldState.channelId} to ${newState.channelId}`);

  // Check if the user just joined the specific verification voice channel
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

      // Create a new voice channel named after the user
      const newChannel = await guild.channels.create({
        name: `verify-${member.user.username}`,
        type: ChannelType.GuildVoice,
        parent: CATEGORY_ID || null,
        permissionOverwrites: [
          {
            id: guild.id,
            deny: [PermissionsBitField.Flags.ViewChannel],
          },
          {
            id: member.id,
            allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak],
          },
          {
            id: STAFF_ROLE_ID,
            allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak],
          },
        ],
      });

      // Move the user into the newly created voice channel
      await member.voice.setChannel(newChannel);
      console.log(`Created verification channel ${newChannel.name} and moved ${member.user.tag}`);

      // Notify staff in a text channel
      const textChannel = guild.channels.cache.find(c => c.type === ChannelType.GuildText && (c.name.includes('staff') || c.name.includes('general') || c.name.includes('verification')));
      if (textChannel) {
        textChannel.send(`<@&${STAFF_ROLE_ID}> New verification session started for **${member.user.tag}** in voice channel **${newChannel.name}**.`);
      }

    } catch (error) {
      console.error(`Failed to create verification voice channel: ${error.message}`);
    }
  }
});

console.log("DEBUG TOKEN CHECK:", process.env.DISCORD_TOKEN ? `Loaded (${process.env.DISCORD_TOKEN.length} chars)` : "MISSING/UNDEFINED");

client.login(process.env.DISCORD_TOKEN);