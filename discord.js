const { Client, GatewayIntentBits, ActivityType } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // Required to detect when members join
  ],
  presence: {
    status: 'online', // Keeps the status explicitly set to online
    activities: [
      {
        name: 'for new members',
        type: ActivityType.Watching,
      },
    ],
  },
});

// Replace with your actual Discord Role ID or use process.env.ROLE_ID
const ROLE_ID = process.env.ROLE_ID || 'YOUR_ROLE_ID_HERE';

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}! Bot is online and ready.`);
});

client.on('guildMemberAdd', async (member) => {
  try {
    const role = member.guild.roles.cache.get(ROLE_ID);
    if (!role) {
      console.error('Role not found. Check your ROLE_ID.');
      return;
    }

    // Grant the role immediately upon joining
    await member.roles.add(role);
    console.log(`Assigned ${role.name} to ${member.user.tag}`);
  } catch (error) {
    console.error(`Failed to assign role: ${error.message}`);
  }
});

client.login('MTU2NzY3MjM0NjkzNDc3MTc5Mg.GWFCFn.knc46HML7_hqN4McxJH4Je1EcO2744KAEBCp7g');


