import { rewriteOpenAICompatibleRequestBody } from "../openai/transform";
import { ProviderTransforms, type ProviderTransform } from "../transform";

const openAiTransform: ProviderTransform = {
  providerId: "openai",
  transformBody: rewriteOpenAICompatibleRequestBody,
};

ProviderTransforms.register(openAiTransform);
