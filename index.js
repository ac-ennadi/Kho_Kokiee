const { Client, GatewayIntentBits, ActivityType, ChannelType, PermissionsBitField } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates, // Required to track voice channel events
  ],
  presence: {
    status: 'online',
    activities: [{ name: 'for new members', type: ActivityType.Watching }],
  },
});

// Configuration IDs (Replace these with your actual IDs)
const ROLE_ID = process.env.ROLE_ID || 'YOUR_ROLE_ID_HERE';                    // Role to assign on member join
const NOT_VERIFIED_ROLE_ID = 'YOUR_NOT_VERIFIED_ROLE_ID_HERE';               // The "not verified" role ID
const TARGET_VC_ID = 'YOUR_VERIFICATION_VOICE_CHANNEL_ID_HERE';              // The static verification room ID to watch
const STAFF_ROLE_ID = 'YOUR_STAFF_ROLE_TO_MENTION_ID_HERE';                  // The role you want to mention in the new room
const CATEGORY_ID = 'YOUR_VOICE_CHANNELS_CATEGORY_ID_HERE';                  // Optional: Category ID where new VCs should be created

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
  // Check if the user just joined the specific verification voice channel
  if (newState.channelId === TARGET_VC_ID && oldState.channelId !== TARGET_VC_ID) {
    const member = newState.member;

    // Check if the user has the "not verified" role
    if (!member.roles.cache.has(NOT_VERIFIED_ROLE_ID)) return;

    try {
      const guild = newState.guild;

      // Create a new voice channel named after the user (e.g., "verification-username")
      const newChannel = await guild.channels.create({
        name: `verify-${member.user.username}`,
        type: ChannelType.GuildVoice,
        parent: CATEGORY_ID || null, // Puts it in the same category if specified
        permissionOverwrites: [
          {
            id: guild.id,
            deny: [PermissionsBitField.Flags.ViewChannel], // Hide from general public
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

      // Find a text channel or send a message to notify the staff role
      // (Optional: Adjust this to send a message in a specific text channel alerting staff)
      const textChannel = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name.includes('staff') || c.name.includes('verification-logs'));
      if (textChannel) {
        textChannel.send(`<@&${STA_FF_ROLE_ID}> New verification session started for **${member.user.tag}** in voice channel **${newChannel.name}**.`);
      }

    } catch (error) {
      console.error(`Failed to create verification voice channel: ${error.message}`);
    }
  }
});

console.log("DEBUG TOKEN CHECK:", process.env.DISCORD_TOKEN ? `Loaded (${process.env.DISCORD_TOKEN.length} chars)` : "MISSING/UNDEFINED");

client.login(process.env.DISCORD_TOKEN);