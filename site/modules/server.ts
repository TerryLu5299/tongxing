// The backend of the site's modules, installed by the api and the worker when they start (site/modules/index.ts).
import type { ServerModule } from "@tongxing/backend/modules";
import selectHourly from "@tongxing/select-hourly/server";

export const SERVER_MODULES: readonly ServerModule[] = [selectHourly];
