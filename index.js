const { Client, GatewayIntentBits, ActivityType } = require('discord.js');
const { createMusicService } = require('./music-service');

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

const musicService = createMusicService(client);
const distube = musicService.distube;

const config = require('./config');
const { createGeminiService } = require('./gemini-service');
const { createDiscordService } = require('./discord-service');
const { createVoiceService } = require('./voice-service');
const { registerMessageHandler } = require('./message-handler');
const gemini = createGeminiService(config.GEMINI_API_KEY, config.DEFAULT_GEMINI_MODEL);
const discordService = createDiscordService({ client, distube, config });
const voiceService = createVoiceService({ client, distube, config, gemini, discord: discordService });
discordService.setVoiceListener(voiceService.listenInVoiceChannel);
musicService.setVoiceListener(voiceService.listenInVoiceChannel);
registerMessageHandler({ client, distube, config, gemini, discord: discordService, voice: voiceService });

client.login(process.env.DISCORD_TOKEN);
