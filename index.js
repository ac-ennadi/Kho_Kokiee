const { Client, GatewayIntentBits, ActivityType } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
  presence: {
    status: 'online',
    activities: [{ name: 'for new members', type: ActivityType.Watching }],
  },
});

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
    await member.roles.add(role);
    console.log(`Assigned ${role.name} to ${member.user.tag}`);
  } catch (error) {
    console.error(`Failed to assign role: ${error.message}`);
  }
});

console.log("DEBUG TOKEN CHECK:", process.env.DISCORD_TOKEN ? `Loaded (${process.env.DISCORD_TOKEN.length} chars)` : "MISSING/UNDEFINED");

client.login(process.env.DISCORD_TOKEN);