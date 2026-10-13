import { z } from "zod";

// The browser CSP forbids runtime code generation. Configure Zod before schemas
// are imported so its capability probe does not attempt new Function().
z.config({ jitless: true });
