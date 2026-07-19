import { validateWheelModelRegistry } from "../../packages/wheel-zob-pack/index.ts";

const result = validateWheelModelRegistry();
if (!result.valid) {
  console.error("WHEEL_MODEL_REGISTRY_FAIL");
  for (const error of result.errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`WHEEL_MODEL_REGISTRY_PASS routes=${result.routeCount} pools=${result.randomizedPoolCount} min_pool=${result.minimumPoolSize}`);
}
