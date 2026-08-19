const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const temp=path.join(__dirname,'.tmp-prd');
fs.rmSync(temp,{recursive:true,force:true});
fs.mkdirSync(temp,{recursive:true});
process.env.DB_FILE=path.join(temp,'test.db');
process.env.OWNER_USERNAME='FeatureOwner';
process.env.OWNER_INITIAL_PASSWORD='feature-owner-secure-password';
process.env.OWNER_EMAIL='owner@college.edu';
process.env.OWNER_NAME='Feature Owner';

const {server,db,ready}=require('../server');
let base;
let serial=0;

test.before(async()=>{
  await ready;
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  base=`http://127.0.0.1:${server.address().port}`;
});

test.after(async()=>{
  await new Promise(resolve=>server.close(resolve));
  await db.close();
  fs.rmSync(temp,{recursive:true,force:true});
});

async function request(url,options={}){
  const response=await fetch(base+url,options);
  return {r:response,data:await response.json()};
}

async function owner(){
  const {r}=await request('/api/auth/login',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({login:'FeatureOwner',password:'feature-owner-secure-password'})
  });
  assert.equal(r.status,200);
  return r.headers.get('set-cookie').split(';')[0];
}

async function register(prefix='student',emailDomain='college.edu'){
  serial++;
  const username=`${prefix}.${serial}`;
  const {r,data}=await request('/api/auth/register',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      name:`Student ${serial}`,
      username,
      email:`${prefix}${serial}@${emailDomain}`,
      password:'long-secure-password'
    })
  });
  assert.equal(r.status,201);
  return {cookie:r.headers.get('set-cookie').split(';')[0],user:data.user,username};
}

const jsonHeaders=cookie=>({'Content-Type':'application/json',cookie});

test('feature hardening migration is recorded',async()=>{
  const migration=await db.get('SELECT version,name FROM schema_migrations WHERE version=?',[2]);
  assert.equal(migration.version,2);
  assert.equal(migration.name,'feature_hardening');
});

test('student ticket responses never include private management notes',async()=>{
  const student=await register('privacy');
  let response=await request('/api/issues',{
    method:'POST',
    headers:jsonHeaders(student.cookie),
    body:JSON.stringify({subject:'Private note test',description:'Please help',category:'Account'})
  });
  assert.equal(response.r.status,201);
  const issueId=response.data.id;

  const ownerCookie=await owner();
  response=await request(`/api/issues/${issueId}`,{
    method:'PATCH',
    headers:jsonHeaders(ownerCookie),
    body:JSON.stringify({status:'in_progress',adminNote:'staff only'})
  });
  assert.equal(response.r.status,200);

  response=await request('/api/issues',{headers:{cookie:student.cookie}});
  assert.equal(response.r.status,200);
  const issue=response.data.issues.find(item=>item.id===issueId);
  assert.equal(Object.hasOwn(issue,'admin_note'),false);

  response=await request('/api/issues',{headers:{cookie:ownerCookie}});
  const managementIssue=response.data.issues.find(item=>item.id===issueId);
  assert.equal(managementIssue.admin_note,'staff only');
});

test('issue conversations separate public replies from management-only replies',async()=>{
  const student=await register('thread');
  let response=await request('/api/issues',{
    method:'POST',
    headers:jsonHeaders(student.cookie),
    body:JSON.stringify({subject:'Conversation',description:'Initial report',category:'Technical'})
  });
  const issueId=response.data.id;
  const ownerCookie=await owner();

  await request(`/api/issues/${issueId}/messages`,{
    method:'POST',
    headers:jsonHeaders(ownerCookie),
    body:JSON.stringify({body:'Visible response',visibility:'public'})
  });
  await request(`/api/issues/${issueId}/messages`,{
    method:'POST',
    headers:jsonHeaders(ownerCookie),
    body:JSON.stringify({body:'Internal detail',visibility:'private'})
  });

  response=await request('/api/issues',{headers:{cookie:student.cookie}});
  const studentIssue=response.data.issues.find(item=>item.id===issueId);
  assert.equal(studentIssue.messages.some(item=>item.body==='Visible response'),true);
  assert.equal(studentIssue.messages.some(item=>item.body==='Internal detail'),false);

  response=await request('/api/issues',{headers:{cookie:ownerCookie}});
  const ownerIssue=response.data.issues.find(item=>item.id===issueId);
  assert.equal(ownerIssue.messages.some(item=>item.body==='Internal detail'&&item.visibility==='private'),true);
});

test('events reject past dates, enforce capacity, and return clean 404s',async()=>{
  const creator=await register('host');
  let response=await request('/api/events',{
    method:'POST',
    headers:jsonHeaders(creator.cookie),
    body:JSON.stringify({title:'Past Event',startsAt:new Date(Date.now()-60000).toISOString(),capacity:2})
  });
  assert.equal(response.r.status,400);

  response=await request('/api/events',{
    method:'POST',
    headers:jsonHeaders(creator.cookie),
    body:JSON.stringify({title:'Small Event',startsAt:new Date(Date.now()+3600000).toISOString(),capacity:2})
  });
  assert.equal(response.r.status,201);
  const eventId=response.data.event.id;
  assert.equal(response.data.event.attendees,1);

  const second=await register('guest');
  response=await request(`/api/events/${eventId}/rsvp`,{method:'POST',headers:jsonHeaders(second.cookie),body:'{}'});
  assert.equal(response.r.status,200);

  const third=await register('late');
  response=await request(`/api/events/${eventId}/rsvp`,{method:'POST',headers:jsonHeaders(third.cookie),body:'{}'});
  assert.equal(response.r.status,409);

  response=await request('/api/events/missing/rsvp',{method:'POST',headers:jsonHeaders(third.cookie),body:'{}'});
  assert.equal(response.r.status,404);

  response=await request(`/api/events/${eventId}/rsvp`,{method:'POST',headers:jsonHeaders(creator.cookie),body:'{}'});
  assert.equal(response.r.status,409);
});

test('announcement audiences are enforced by the server',async()=>{
  const ownerCookie=await owner();
  let response=await request('/api/announcements',{
    method:'POST',
    headers:jsonHeaders(ownerCookie),
    body:JSON.stringify({title:'Faculty only',body:'Staff note',audience:'Faculty'})
  });
  assert.equal(response.r.status,201);

  const student=await register('audience');
  response=await request('/api/announcements',{headers:{cookie:student.cookie}});
  assert.equal(response.data.announcements.some(item=>item.title==='Faculty only'),false);

  response=await request(`/api/admin/users/${student.user.id}/role`,{
    method:'PATCH',
    headers:jsonHeaders(ownerCookie),
    body:JSON.stringify({role:'faculty'})
  });
  assert.equal(response.r.status,200);

  response=await request('/api/announcements',{headers:{cookie:student.cookie}});
  assert.equal(response.data.announcements.some(item=>item.title==='Faculty only'),true);
});

test('last owner protection and role management work',async()=>{
  const ownerCookie=await owner();
  const ownerRow=await db.get("SELECT id FROM users WHERE role='owner' LIMIT 1");
  let response=await request(`/api/admin/users/${ownerRow.id}/role`,{
    method:'PATCH',
    headers:jsonHeaders(ownerCookie),
    body:JSON.stringify({role:'management'})
  });
  assert.equal(response.r.status,409);

  const candidate=await register('manager');
  response=await request(`/api/admin/users/${candidate.user.id}/role`,{
    method:'PATCH',
    headers:jsonHeaders(ownerCookie),
    body:JSON.stringify({role:'management'})
  });
  assert.equal(response.r.status,200);

  const audit=await db.get('SELECT to_role FROM role_audit WHERE user_id=? ORDER BY created_at DESC LIMIT 1',[candidate.user.id]);
  assert.equal(audit.to_role,'management');
});

test('missing follow, reaction, comment and club targets return 404',async()=>{
  const user=await register('missing');
  let response=await request('/api/users/not-real/follow',{method:'POST',headers:jsonHeaders(user.cookie),body:'{}'});
  assert.equal(response.r.status,404);
  response=await request('/api/posts/not-real/react',{method:'POST',headers:jsonHeaders(user.cookie),body:'{}'});
  assert.equal(response.r.status,404);
  response=await request('/api/posts/not-real/comments',{method:'POST',headers:jsonHeaders(user.cookie),body:JSON.stringify({body:'hello'})});
  assert.equal(response.r.status,404);
  response=await request('/api/clubs/not-real/join',{method:'POST',headers:jsonHeaders(user.cookie),body:'{}'});
  assert.equal(response.r.status,404);
});

test('following feed, pagination, saves, permalink reads, reactions, and post edits work',async()=>{
  const author=await register('author');
  const reader=await register('reader');

  await request(`/api/users/${author.user.id}/follow`,{method:'POST',headers:jsonHeaders(reader.cookie),body:'{}'});
  const created=[];
  for(let i=0;i<3;i++){
    const response=await request('/api/posts',{
      method:'POST',
      headers:jsonHeaders(author.cookie),
      body:JSON.stringify({body:`Followed post ${i}`,type:'post',tags:['Test']})
    });
    created.push(response.data.post.id);
    await new Promise(resolve=>setTimeout(resolve,2));
  }

  let response=await request('/api/posts?scope=following&limit=2',{headers:{cookie:reader.cookie}});
  assert.equal(response.r.status,200);
  assert.equal(response.data.posts.length,2);
  assert.ok(response.data.nextCursor);
  assert.equal(response.data.posts.every(post=>post.author.id===author.user.id),true);

  const postId=created[0];
  response=await request(`/api/posts/${postId}/save`,{method:'POST',headers:jsonHeaders(reader.cookie),body:'{}'});
  assert.equal(response.data.saved,true);
  response=await request('/api/posts?saved=1',{headers:{cookie:reader.cookie}});
  assert.equal(response.data.posts.some(post=>post.id===postId&&post.saved),true);

  response=await request(`/api/posts/${postId}`,{headers:{cookie:reader.cookie}});
  assert.equal(response.data.post.id,postId);

  response=await request(`/api/posts/${postId}/react`,{method:'POST',headers:jsonHeaders(reader.cookie),body:JSON.stringify({kind:'spark'})});
  assert.equal(response.data.post.reacted,true);
  const reaction=await db.get('SELECT kind FROM reactions WHERE post_id=? AND user_id=?',[postId,reader.user.id]);
  assert.equal(reaction.kind,'like');

  response=await request(`/api/posts/${postId}`,{
    method:'PATCH',
    headers:jsonHeaders(author.cookie),
    body:JSON.stringify({body:'Edited followed post'})
  });
  assert.equal(response.r.status,200);
  assert.equal(response.data.post.body,'Edited followed post');
  assert.ok(response.data.post.editedAt);
});

test('project and club owners cannot leave and lifecycle states are enforced',async()=>{
  const creator=await register('lifecycle');
  let response=await request('/api/projects',{
    method:'POST',
    headers:jsonHeaders(creator.cookie),
    body:JSON.stringify({name:'Lifecycle Project',pitch:'Test lifecycle',capacity:3})
  });
  const projectId=response.data.project.id;
  response=await request(`/api/projects/${projectId}/join`,{method:'POST',headers:jsonHeaders(creator.cookie),body:'{}'});
  assert.equal(response.r.status,409);
  response=await request(`/api/projects/${projectId}`,{
    method:'PATCH',
    headers:jsonHeaders(creator.cookie),
    body:JSON.stringify({status:'completed'})
  });
  assert.equal(response.r.status,200);
  const outsider=await register('projectjoin');
  response=await request(`/api/projects/${projectId}/join`,{method:'POST',headers:jsonHeaders(outsider.cookie),body:'{}'});
  assert.equal(response.r.status,409);

  response=await request('/api/clubs',{
    method:'POST',
    headers:jsonHeaders(creator.cookie),
    body:JSON.stringify({name:'Lifecycle Club',description:'Test club',category:'Testing'})
  });
  const clubId=response.data.club.id;
  response=await request(`/api/clubs/${clubId}/join`,{method:'POST',headers:jsonHeaders(creator.cookie),body:'{}'});
  assert.equal(response.r.status,409);
  response=await request(`/api/clubs/${clubId}`,{
    method:'PATCH',
    headers:jsonHeaders(creator.cookie),
    body:JSON.stringify({status:'closed'})
  });
  assert.equal(response.r.status,200);
  response=await request(`/api/clubs/${clubId}/join`,{method:'POST',headers:jsonHeaders(outsider.cookie),body:'{}'});
  assert.equal(response.r.status,409);
});

test('profile link labels survive editing and admin stats do not expose emails',async()=>{
  const student=await register('links');
  let response=await request('/api/profile',{
    method:'PATCH',
    headers:jsonHeaders(student.cookie),
    body:JSON.stringify({
      name:'Links Student',
      username:student.username,
      links:[{label:'Portfolio',url:'https://example.com/portfolio'}]
    })
  });
  assert.equal(response.data.user.links[0].label,'Portfolio');

  const ownerCookie=await owner();
  response=await request('/api/admin/stats',{headers:{cookie:ownerCookie}});
  assert.equal(response.r.status,200);
  assert.equal(response.data.recentUsers.some(user=>Object.hasOwn(user,'email')),false);
});

test('optional campus email restriction rejects unapproved domains',async()=>{
  process.env.CAMPUS_EMAIL_DOMAINS='college.edu';
  const username=`domain.${++serial}`;
  let response=await request('/api/auth/register',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({name:'Wrong Domain',username,email:`wrong${serial}@example.com`,password:'long-secure-password'})
  });
  assert.equal(response.r.status,400);
  response=await request('/api/auth/register',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({name:'Right Domain',username:`domain.ok.${serial}`,email:`right${serial}@college.edu`,password:'long-secure-password'})
  });
  assert.equal(response.r.status,201);
  delete process.env.CAMPUS_EMAIL_DOMAINS;
});
