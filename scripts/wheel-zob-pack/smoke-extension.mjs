import wheelZobPackExtension from "../../packages/wheel-zob-pack/extension.ts";

const tools = [];
const commands = [];
const events = [];
const fakePi = {
  registerTool(definition) { tools.push(definition.name); },
  registerCommand(name) { commands.push(name); },
  on(name) { events.push(name); },
};
wheelZobPackExtension(fakePi);
const expectedTools = ["wheel_zob_preview_mission", "wheel_zob_simulate_pipeline", "wheel_zob_validate_story"];
const passed = tools.length === expectedTools.length
  && expectedTools.every((name) => tools.includes(name))
  && commands.length === 1
  && commands.includes("wheel-zob")
  && events.includes("session_start");
if (!passed) {
  console.error(`WHEEL_ZOB_EXTENSION_FAIL tools=${tools.join(",")} commands=${commands.join(",")} events=${events.join(",")}`);
  process.exitCode = 1;
} else {
  console.log(`WHEEL_ZOB_EXTENSION_PASS tools=${tools.length} commands=${commands.length} effects=false`);
}
