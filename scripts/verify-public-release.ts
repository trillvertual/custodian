import { parseArgs } from "node:util";
import { verifyPublicRelease } from "./release-verifier.ts";

const { values } = parseArgs({
  options: {
    tag: { type: "string" },
    revision: { type: "string" },
    output: { type: "string" },
    latest: { type: "boolean", default: false },
  },
});
const report = await verifyPublicRelease({
  tag: values.tag ?? "",
  revision: values.revision ?? "",
  output: values.output,
  latest: values.latest,
});
console.log(JSON.stringify(report, null, 2));
