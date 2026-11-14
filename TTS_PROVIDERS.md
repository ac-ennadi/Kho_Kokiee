# Voice TTS providers

The bot can use the following providers. With `VOICE_TTS_PROVIDER=auto`, it tries them in this order and stops at the first successful synthesis:

1. Gemini
2. HADRA
3. Kandir DarijaTTS (only when `KANDIR_TTS_URL` is set)
4. SpeechT5 Darija (only when `SPEECHT5_TTS_URL` is set)
5. Edge TTS
6. Azure Speech

The bot must already be in the same voice channel as the speaker before it will play a spoken reply.

## Edge TTS

The Docker image installs the `edge-tts` command. It needs no API key and defaults to the male Moroccan Arabic voice `ar-MA-JamalNeural`.

Optional Railway variables:

- `EDGE_TTS_VOICE=ar-MA-JamalNeural` (male)
- `EDGE_TTS_VOICE=ar-MA-MounaNeural` (female)
- `EDGE_TTS_COMMAND=/opt/edge-tts/bin/edge-tts` (already set by the Docker image)

Edge TTS depends on Microsoft's online Edge speech endpoint, so it needs outbound internet access and may be subject to service-side limits.

## Kandir and SpeechT5

The Hugging Face model cards do not currently provide hosted inference for these models. Kandir's public demo currently reports a runtime error, and the SpeechT5 demo may require access. To use either one in the bot, deploy the model behind a small HTTP adapter and set its Railway URL:

- `KANDIR_TTS_URL` and optional `KANDIR_TTS_TOKEN`
- `SPEECHT5_TTS_URL` and optional `SPEECHT5_TTS_TOKEN`

Each endpoint must accept `POST` JSON `{ "text": "...", "format": "wav" }`, optionally authorize `Bearer <token>`, and return raw WAV bytes (`audio/wav`). Kandir receives Arabic-script Darija; SpeechT5 receives Latin-script Darija. Failed endpoints are paused for five minutes before retrying.

## Selecting a provider

`VOICE_TTS_PROVIDER` defaults to `auto`. To use one provider by itself while trying it, set it to `gemini`, `hadra`, `kandir`, `speecht5`, `edge`, or `azure`. A selected provider needs to be configured and healthy; `auto` is the normal fallback mode.
