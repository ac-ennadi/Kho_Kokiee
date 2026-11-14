const config = {
  ROLE_ID: process.env.ROLE_ID,
  NOT_VERIFIED_ROLE_ID: process.env.NOT_VERIFIED_ROLE_ID,
  TARGET_VC_ID: process.env.TARGET_VC_ID,
  STAFF_ROLE_ID: process.env.STAFF_ROLE_ID,
  MOVE_ROLE_ID: process.env.MOVE_ROLE_ID,
  CATEGORY_ID: process.env.CATEGORY_ID || null,
  CREATE_VC_ID: process.env.CREATE_VC_ID,
  CREATE_CATEGORY_ID: process.env.CREATE_CATEGORY_ID || null,
  LOG_CHANNEL_ID: process.env.LOG_CHANNEL_ID || null,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  DEFAULT_GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
  GEMINI_TTS_MODEL: process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-lite-tts',
  GEMINI_TTS_VOICE: process.env.GEMINI_TTS_VOICE || 'Fenrir',
  AZURE_SPEECH_KEY: process.env.AZURE_SPEECH_KEY,
  AZURE_SPEECH_REGION: process.env.AZURE_SPEECH_REGION,
  AZURE_SPEECH_VOICE: process.env.AZURE_SPEECH_VOICE || 'ar-MA-JamalNeural',
  HADRA_TTS_URL: process.env.HADRA_TTS_URL || null,
  VOICE_TTS_ENABLED: process.env.VOICE_TTS_ENABLED !== 'false',
};

module.exports = config;
