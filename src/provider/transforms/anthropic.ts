import {
  anthropicBypassBody,
  anthropicBypassHeaders,
  anthropicBypassResponse,
  anthropicBypassStreamLine,
} from "../../agent-plugins/anthropic-bypass";
import { ProviderTransforms, type ProviderTransform } from "../transform";

const anthropicTransform: ProviderTransform = {
  providerId: "anthropic",
  transformHeaders: anthropicBypassHeaders,
  transformBody: anthropicBypassBody,
  transformResponse: anthropicBypassResponse,
  transformStreamLine: anthropicBypassStreamLine,
};

ProviderTransforms.register(anthropicTransform);
