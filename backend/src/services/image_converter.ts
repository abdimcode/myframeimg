import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { resolveScreenProfile } from "../config/screens";
import { normalizeUploadToSrgbJpeg, writeMyfmSidecar } from "./myfm_encode";
import { db } from "../db/store";
const exec = promisify(execFile);
export async function convertFrameImage(input: string, mac: string): Promise<string> {
 const norm=(v:string)=>String(v||"").replace(/[^a-fA-F0-9]/g,"").toUpperCase();
 const frame=db.read().frames.find(f=>[f.id,f.bleMac,f.stationMac||""].some(v=>norm(v)===norm(mac)));
 const p=resolveScreenProfile(frame?.screenSize,frame?.fpgaVer);
 if(p.screen===31 && process.env.FRAME_VENDOR_RENDER!=="1") return writeMyfmSidecar(input);
 const root=path.resolve("vendor/fpga-render");
 const work=await fs.mkdtemp(path.join(root,"render-"));
 try {
  const source=path.join(work,"input.png"), output=path.join(work,"output.bin");
  await sharp(await normalizeUploadToSrgbJpeg(input)).rotate().resize(p.width,p.height,{fit:"cover"}).png().toFile(source);
  await exec(path.join(root,"bin/fpga_render_cli"),["--screen",String(p.screen),"--in",source,"--out",output,"--mode","16","--color","E6"],{cwd:root,timeout:90000,maxBuffer:1024*1024,killSignal:"SIGKILL"});
  const bytes=await fs.readFile(output); if(bytes.length<4) throw new Error("vendor_empty_output");
  const name=path.parse(input).name+".bin";await fs.writeFile(path.join(path.dirname(input),name),bytes);
  return name;
 } finally { await fs.rm(work,{recursive:true,force:true}); }
}
