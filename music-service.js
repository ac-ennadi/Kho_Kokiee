const fs = require('fs');
const path = require('path');

function createMusicService(client) {
  try {
    const { generateDependencyReport } = require('@discordjs/voice');
    console.log('[Voice Dependencies]\n' + generateDependencyReport());
  } catch (error) {
    console.warn(`[Voice] Could not generate dependency report: ${error.message}`);
  }

  let ffmpegPath = fs.existsSync('/usr/bin/ffmpeg') ? '/usr/bin/ffmpeg' : null;
  if (!ffmpegPath) {
    try { ffmpegPath = require('ffmpeg-static'); }
    catch (error) { console.warn(`[Music] ffmpeg-static unavailable: ${error.message}`); }
  }
  if (ffmpegPath) {
    const ffmpegDirectory = path.dirname(ffmpegPath);
    process.env.PATH = `${ffmpegDirectory}${path.delimiter}${process.env.PATH || ''}`;
    console.log(`[Music] FFmpeg ready: ${ffmpegPath}`);
  }

  let DisTube = null;
  let YouTubePlugin = null;
  let YtDlpPlugin = null;
  let SoundCloudPlugin = null;
  try { DisTube = require('distube').DisTube; } catch (error) { console.error(`[Music] Could not load DisTube: ${error.message}`); }
  try { YouTubePlugin = require('@distube/youtube').YouTubePlugin; } catch (error) { console.error(`[Music] Could not load YouTube plugin: ${error.message}`); }
  try { YtDlpPlugin = require('@distube/yt-dlp').YtDlpPlugin; } catch (error) { console.error(`[Music] Could not load yt-dlp plugin: ${error.message}`); }
  try { SoundCloudPlugin = require('@distube/soundcloud').SoundCloudPlugin; } catch (error) { console.warn(`[Music] SoundCloud plugin unavailable: ${error.message}`); }

  const plugins = [];
  if (SoundCloudPlugin) plugins.push(new SoundCloudPlugin());
  if (YouTubePlugin) plugins.push(new YouTubePlugin());
  if (YtDlpPlugin) plugins.push(new YtDlpPlugin());

  let distube = null;
  if (DisTube) {
    try {
      distube = new DisTube(client, {
        plugins,
        emitNewSongOnly: true,
        ffmpeg: { path: ffmpegPath || 'ffmpeg' },
      });
    } catch (error) {
      console.error(`[Music] Could not initialize DisTube: ${error.stack || error.message}`);
    }
  }

  const redactMediaUrls = value => String(value).replace(/https?:\/\/[^\s"'<>]+/gi, rawUrl => {
    try {
      const parsed = new URL(rawUrl);
      return `${parsed.origin}${parsed.pathname}[query-redacted]`;
    } catch {
      return '[media-url-redacted]';
    }
  });

  let listenInVoiceChannel = () => {};
  if (distube) {
    const ffmpegDebugCounts = new Map();
    distube.on('ffmpegDebug', debug => {
      const message = redactMediaUrls(debug);
      const processId = message.match(/\[(\d{8,})\]/)?.[1] || 'unknown';
      const count = ffmpegDebugCounts.get(processId) || 0;
      if (count < 25) {
        console.warn(`[Music][FFmpeg] ${message}`);
        ffmpegDebugCounts.set(processId, count + 1);
      } else if (count === 25) {
        console.warn(`[Music][FFmpeg] Suppressing further FFmpeg output for process ${processId}.`);
        ffmpegDebugCounts.set(processId, count + 1);
      }
    });

    distube.on('playSong', (queue, song) => {
      queue?.textChannel?.send(`🎶 Daba kayn-playi: \`${song.name}\``).catch(() => {});
      try {
        const guild = client.guilds.cache.get(queue.id);
        const voice = guild && distube.voices.get(guild.id);
        if (voice) {
          const unmuteReceiver = voice.setSelfDeaf(false);
          if (unmuteReceiver && typeof unmuteReceiver.catch === 'function') {
            unmuteReceiver.catch(error => console.warn(`[Voice Listen] Could not enable receiving: ${error.message}`));
          }
          listenInVoiceChannel(guild, voice.connection, queue.textChannel);
        }
      } catch (error) {
        console.warn(`[Voice Listen] Could not attach receiver: ${error.message}`);
      }
    });

    distube.on('addSong', (queue, song) => {
      queue?.textChannel?.send(`✅ Tzad l queue: \`${song.name}\``).catch(() => {});
    });

    distube.on('finish', queue => {
      setTimeout(() => {
        const currentQueue = distube.getQueue(queue.id);
        if (!currentQueue || !currentQueue.playing) {
          try { queue.voice.leave(); } catch {}
        }
      }, 15000);
    });

    distube.on('error', (error, queue, song) => {
      console.error(`[Music] Failed track: ${song?.name || 'unknown'}; source: ${song?.source || 'unknown'}; code: ${error?.errorCode || error?.code || 'unknown'}`);
      console.error('[Music] Playback error:', redactMediaUrls(error?.stack || error?.message || error));
      if (!queue?.textChannel) return;
      const code = error?.errorCode || error?.code || '';
      const userMessage = song?.source === 'soundcloud' && code === 'FFMPEG_EXITED'
        ? '❌ SoundCloud ma9drch yplayi had version (ymken protected aw unavailable). Jreb chi upload/version okhra.'
        : song?.source === 'youtube' && /BOT_CHECK|Sign in to confirm/i.test(`${code} ${error?.message || ''}`)
          ? '❌ YouTube blocka l-bot f Railway f had track. Jreb chi upload/version okhra.'
          : '❌ Ma khdemch l-music daba. Jreb chi track akhor.';
      queue.textChannel.send(userMessage).catch(() => {});
    });
  }

  return {
    distube,
    setVoiceListener(listener) { listenInVoiceChannel = listener; },
  };
}

module.exports = { createMusicService };
