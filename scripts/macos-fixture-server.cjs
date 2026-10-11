/** Local, synthetic Jellyfin fixture for macOS native integration checks. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const media = path.join(root, '.tmp/macos-libmpv/test-hevc/fixture.mkv');
if (!fs.existsSync(media)) throw new Error('Generate the synthetic fixture: ./scripts/prototype-macos-mpv.sh --self-test-hevc');
const events = [];
const movie = {
  Id:'mac-fixture-movie', Name:'Mac GPU 合成测试', Type:'Movie', Container:'mkv', ProductionYear:2026,
  Overview:'合成的 4K 10-bit HEVC 视频，用于验证媒体库 → libmpv → GPU 玻璃控件。',
  RunTimeTicks:20000000, UserData:{PlaybackPositionTicks:0,Played:false,IsFavorite:false},
  MediaSources:[{Id:'mac-fixture-source',Container:'mkv',SupportsDirectPlay:true,SupportsDirectStream:true,
    RunTimeTicks:20000000,MediaStreams:[{Index:0,Type:'Video',Codec:'hevc',Width:3840,Height:2160,BitDepth:10}]}],
};
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://fixture');
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','Authorization,X-Emby-Authorization,X-Emby-Token,Content-Type');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,DELETE,OPTIONS');
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
  const json=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  if(url.pathname==='/fixture/events') return json(events);
  if(url.pathname==='/System/Info/Public') return json({Id:'mac-fixture',Version:'10.10.7',ProductName:'Jellyfin Server',ServerName:'Mac GPU 本地测试'});
  if(url.pathname==='/Users/AuthenticateByName') return json({AccessToken:'synthetic-fixture-token',ServerId:'mac-fixture',User:{Id:'fixture-user',Name:'fixture'}});
  if(url.pathname.startsWith('/Videos/mac-fixture-movie/')){
    events.push({kind:'media',range:!!req.headers.range});
    const stat=fs.statSync(media);
    const match=req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const start=match?Number(match[1]):0,end=match&&match[2]?Math.min(Number(match[2]),stat.size-1):stat.size-1;
    res.writeHead(match?206:200,{'Content-Type':'video/x-matroska','Accept-Ranges':'bytes','Content-Length':end-start+1,
      ...(match?{'Content-Range':`bytes ${start}-${end}/${stat.size}`}:{})});
    fs.createReadStream(media,{start,end}).pipe(res);return;
  }
  if(url.pathname.includes('/Images/')){res.writeHead(404);res.end();return;}
  if(url.pathname==='/Users/fixture-user/Views') return json({Items:[{Id:'fixture-library',Name:'GPU 测试媒体库',Type:'CollectionFolder',CollectionType:'movies',RecursiveItemCount:1}],TotalRecordCount:1});
  if(url.pathname==='/Users/fixture-user/Items/mac-fixture-movie') return json(movie);
  if(url.pathname==='/Users/fixture-user/Items/Latest') return json([movie]);
  if(url.pathname.endsWith('/Items/Resume')||url.pathname==='/Shows/NextUp') return json({Items:[],TotalRecordCount:0});
  if(url.pathname==='/Items/mac-fixture-movie/PlaybackInfo') return json({PlaySessionId:'fixture-session',MediaSources:movie.MediaSources});
  if(url.pathname.startsWith('/Sessions/')) {
    let body='';for await(const chunk of req)body+=chunk;
    const data=body?JSON.parse(body):{};
    events.push({kind:'report',path:url.pathname,position:data.PositionTicks,paused:data.IsPaused});
    res.writeHead(204);res.end();return;
  }
  if(url.pathname.includes('/Similar')||url.searchParams.get('IncludeItemTypes')==='Person') return json({Items:[],TotalRecordCount:0});
  if(url.pathname==='/Users/fixture-user/Items') return json({Items:[movie],TotalRecordCount:1});
  return json({Items:[],TotalRecordCount:0});
});
server.listen(5199,'127.0.0.1',()=>console.log('Synthetic media fixture: http://127.0.0.1:5199 (username fixture; password fixture)'));
