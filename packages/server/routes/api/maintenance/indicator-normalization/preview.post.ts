import { defineEventHandler } from "h3";
import { previewIndicatorNormalization } from "../../../../services/indicator-normalization.service";
import { ok } from "../../../../utils/api-response";
import { getRequestUser } from "../../../../utils/request-user";

export default defineEventHandler(event => ok(previewIndicatorNormalization(getRequestUser(event))));
