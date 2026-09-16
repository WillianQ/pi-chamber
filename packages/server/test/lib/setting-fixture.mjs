// e2e 测试共用的"隔离设置文件"。
//
// 为什么要它：服务端现在从 ~/.pi/pi-chamber-global-setting.json 读密码/密钥（不再有 .env、
// 也不再读 PASSWORD / JWT_SECRET 环境变量）。测试必须把服务指到一份临时文件上，
// 否则跑一次测试就把**用户真实的密码**改了。
import { writeFile } from "node:fs/promises";
import path from "node:path";

export const TEST_PASSWORD = "test-password";
export const TEST_JWT_SECRET = "test-secret";

/** 在 dir 下写一份已知凭据的设置文件，返回它的路径（给 PI_CHAMBER_SETTING 用） */
export async function writeSettingFile(dir, port) {
  const file = path.join(dir, "pi-chamber-global-setting.json");
  await writeFile(
    file,
    JSON.stringify(
      {
        version: 1,
        password: TEST_PASSWORD,
        jwtSecret: TEST_JWT_SECRET,
        port,
        termdPort: 3002,
        tts: { enabled: false, dashscopeApiKey: null, voice: "longanhuan_v3.6", rate: 1 },
        stt: { enabled: false, dashscopeApiKey: null },
      },
      null,
      2
    )
  );
  return file;
}
