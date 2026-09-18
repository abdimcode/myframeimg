import express from "express";
import { builtInManifest } from "../services/builtin_images";
export const frameBuiltinRouter=express.Router();
frameBuiltinRouter.get("/frames/:mac/built-in-manifest",async(req,res)=>{
 try { res.json(await builtInManifest(String(req.params.mac))); }
 catch(error){const message=error instanceof Error?error.message:"builtin_unavailable";res.status(message==="frame_not_found"?404:503).json({ok:false,error:message==="frame_not_found"?message:"builtin_assets_unavailable"});}
});
