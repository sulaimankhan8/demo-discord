

import http from "http";

const server=http.createServer((req,res)=>{
    res.writeHead(200,{'content-type':'text/plain'});
    
    res.end(JSON.stringify({message:"ok runningg"}));
})

server.listen(3000,()=>console.log("run"));