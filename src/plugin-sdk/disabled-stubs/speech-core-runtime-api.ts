// TTS runtime stub used in single-file bundle builds where the speech-core
// extension is not shipped on disk. All methods are safe no-ops that match
// the TtsRuntimeFacade contract without performing any TTS work.

import type { TtsRuntimeFacade } from "../tts-runtime.types.js";

const FAKE_PROVIDER_ORDER = Object.freeze<string[]>([]);

const stub: TtsRuntimeFacade = {
  _test: {
    getDirective: () => undefined,
    parseDirective: () => undefined,
  } as unknown as TtsRuntimeFacade["_test"],
  buildTtsSystemPromptHint: () => undefined,
  getLastTtsAttempt: () => undefined,
  getResolvedSpeechProviderConfig: () =>
    ({}) as ReturnType<TtsRuntimeFacade["getResolvedSpeechProviderConfig"]>,
  getTtsMaxLength: () => 0,
  getTtsProvider: () => "openai" as unknown as ReturnType<TtsRuntimeFacade["getTtsProvider"]>,
  isSummarizationEnabled: () => false,
  isTtsEnabled: () => false,
  isTtsProviderConfigured: () => false,
  listSpeechVoices: async () => [],
  maybeApplyTtsToPayload: async (params) => params.payload,
  resolveExplicitTtsOverrides: () =>
    ({}) as ReturnType<TtsRuntimeFacade["resolveExplicitTtsOverrides"]>,
  resolveTtsAutoMode: () => "off" as unknown as ReturnType<TtsRuntimeFacade["resolveTtsAutoMode"]>,
  resolveTtsConfig: () =>
    ({ mode: "off" }) as unknown as ReturnType<TtsRuntimeFacade["resolveTtsConfig"]>,
  resolveTtsPrefsPath: () => "",
  resolveTtsProviderOrder: () =>
    FAKE_PROVIDER_ORDER as unknown as ReturnType<TtsRuntimeFacade["resolveTtsProviderOrder"]>,
  setLastTtsAttempt: () => undefined,
  setSummarizationEnabled: () => undefined,
  setTtsAutoMode: () => undefined,
  setTtsEnabled: () => undefined,
  setTtsMaxLength: () => undefined,
  setTtsProvider: () => undefined,
  synthesizeSpeech: async () => {
    throw new Error(
      "TTS synthesizeSpeech is unavailable in this build (speech-core runtime not shipped).",
    );
  },
  textToSpeech: async () => {
    throw new Error(
      "TTS textToSpeech is unavailable in this build (speech-core runtime not shipped).",
    );
  },
  textToSpeechTelephony: async () => {
    throw new Error(
      "TTS textToSpeechTelephony is unavailable in this build (speech-core runtime not shipped).",
    );
  },
};

export default stub;
export const _test = stub._test;
export const buildTtsSystemPromptHint = stub.buildTtsSystemPromptHint;
export const getLastTtsAttempt = stub.getLastTtsAttempt;
export const getResolvedSpeechProviderConfig = stub.getResolvedSpeechProviderConfig;
export const getTtsMaxLength = stub.getTtsMaxLength;
export const getTtsProvider = stub.getTtsProvider;
export const isSummarizationEnabled = stub.isSummarizationEnabled;
export const isTtsEnabled = stub.isTtsEnabled;
export const isTtsProviderConfigured = stub.isTtsProviderConfigured;
export const listSpeechVoices = stub.listSpeechVoices;
export const maybeApplyTtsToPayload = stub.maybeApplyTtsToPayload;
export const resolveExplicitTtsOverrides = stub.resolveExplicitTtsOverrides;
export const resolveTtsAutoMode = stub.resolveTtsAutoMode;
export const resolveTtsConfig = stub.resolveTtsConfig;
export const resolveTtsPrefsPath = stub.resolveTtsPrefsPath;
export const resolveTtsProviderOrder = stub.resolveTtsProviderOrder;
export const setLastTtsAttempt = stub.setLastTtsAttempt;
export const setSummarizationEnabled = stub.setSummarizationEnabled;
export const setTtsAutoMode = stub.setTtsAutoMode;
export const setTtsEnabled = stub.setTtsEnabled;
export const setTtsMaxLength = stub.setTtsMaxLength;
export const setTtsProvider = stub.setTtsProvider;
export const synthesizeSpeech = stub.synthesizeSpeech;
export const textToSpeech = stub.textToSpeech;
export const textToSpeechTelephony = stub.textToSpeechTelephony;
