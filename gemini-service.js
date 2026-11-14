const { GoogleGenerativeAI } = require('@google/generative-ai');

function createGeminiService(apiKey, defaultModel) {
  let availableModelsCache = [];
  const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;
  const GEMINI_API_KEY = apiKey;
  const DEFAULT_GEMINI_MODEL = defaultModel;

async function fetchSupportedModels() {
  if (!GEMINI_API_KEY) return [];
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      const models = (data.models || [])
        .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
        .map(m => m.name.replace(/^models\//, ''));
      if (models.length > 0) {
        availableModelsCache = models;
        return models;
      }
    }
  } catch (e) {
    console.error(`Could not fetch model list: ${e.message}`);
  }
  return [];
}

function getModelCandidates() {
  // Never wait for model discovery on a user request. Use the configured fast
  // model immediately and keep one discovered Flash model as a 404 fallback.
  const flashModels = availableModelsCache.filter(m =>
    m.toLowerCase().includes('flash') && 
    !m.toLowerCase().includes('tts') && 
    !m.toLowerCase().includes('vision') &&
    !m.toLowerCase().includes('embedding')
  );
  const fallback = flashModels.find(m => m !== DEFAULT_GEMINI_MODEL && m.toLowerCase().includes('flash-lite'))
    || flashModels.find(m => m !== DEFAULT_GEMINI_MODEL);
  return fallback ? [DEFAULT_GEMINI_MODEL, fallback] : [DEFAULT_GEMINI_MODEL];
}

  function excludeModel(modelName) {
    availableModelsCache = availableModelsCache.filter(model => model !== modelName);
  }

  if (apiKey) fetchSupportedModels().catch(() => {});
  return { genAI, getModelCandidates, excludeModel };
}

module.exports = { createGeminiService };
