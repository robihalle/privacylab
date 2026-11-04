import { privacyApi } from "../../../../lib/privacy-api.mjs";

export const runtime = "nodejs";

async function handle(request: Request) {
  const response = await privacyApi(request, process.env, {
    allowInternalGateway: true,
    publicOrigin: process.env.LAB_ORIGIN,
  });
  return response ?? new Response(null, { status: 404 });
}

export { handle as GET, handle as POST };
