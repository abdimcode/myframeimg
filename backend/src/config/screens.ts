export type ScreenProfile = { screen: number; width: number; height: number; size: string };
const profiles: Record<number, ScreenProfile> = Object.fromEntries([
[30,2560,1440,"31.5"],[31,1200,1600,"13.3"],[32,680,960,"5.9"],[33,1200,1600,"7.09"],
[150,1600,1200,"10"],[151,2160,3060,"28.5"],[152,3200,1800,"25.3"],[153,2560,1440,"31.5"],[154,3840,1080,"28"]
].map(([screen,width,height,size]) => [screen,{screen:Number(screen),width:Number(width),height:Number(height),size:String(size)}]));
export function resolveScreenProfile(screenSize?: string, fpgaVer?: string): ScreenProfile {
 const size = String(screenSize || "").trim().replace(/["″]/g,"");
 const fpga = /[1-9]/.test(String(fpgaVer || ""));
 const id = size === "31.5" ? (fpga ? 153 : 30) : ({"13.3":31,"5.9":32,"6":32,"7.09":33,"7.9":33,"10":150,"28.5":151,"25.3":152,"28":154} as Record<string,number>)[size] || 31;
 return profiles[id];
}
