import fs from "fs/promises";
import path from "path";
import { db } from "../db/store";
import { resolveScreenProfile } from "../config/screens";
import { publishFrameCommand, resolveMqttHardwareMac } from "./frame_mqtt";
export const BUILTIN_KEYS=["SET","FACTORY","NO_WIFI","LOW_BATTORY","LOW_POWER_OFF","CONNECTED"] as const;
// CRC-16/CCITT-FALSE: poly 0x1021, init 0xffff, no reflection/xorout.
export function crc16Ccitt(bytes: Uint8Array): number {
 let crc=0xffff;for(const byte of bytes){crc^=byte<<8;for(let i=0;i<8;i++)crc=((crc<<1)^((crc&0x8000)?0x1021:0))&0xffff;}return crc;
}
export async function builtInManifest(mac:string) {
 const target=resolveMqttHardwareMac(mac);
 if(!target) throw new Error("frame_not_found");
 const frame=db.read().frames.find(f=>[f.id,f.bleMac,f.stationMac||""].some(id=>resolveMqttHardwareMac(id)===target));
 if(!frame) throw new Error("frame_not_found");
 const profile=resolveScreenProfile(frame.screenSize,frame.fpgaVer);
 const result:Record<string,string[]>={};
 for(const key of BUILTIN_KEYS){
  const relative="/static/builtin/"+profile.screen+"/"+key+".bin";
  const bytes=await fs.readFile(path.resolve("."+relative));
  if(bytes.length<4)throw new Error("invalid_builtin_asset");
  result[key]=["0","0",String(profile.width),String(profile.height),String(crc16Ccitt(bytes)),relative];
 }
 return result;
}
export async function publishBuiltInImages(mac:string) {
 const target=resolveMqttHardwareMac(mac);
 if(!target) throw new Error("frame_not_found");
 await builtInManifest(target); // Never publish an incomplete download manifest.
 return publishFrameCommand(target,"down_int_img",{host:"47.76.164.162",port:3001,path:"/api/device/builtin-manifest?mac="+target},String(Date.now()));
}
