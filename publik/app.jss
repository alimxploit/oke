let token=localStorage.getItem("wa_rental_token");
const $=id=>document.getElementById(id);
const money=n=>new Intl.NumberFormat("id-ID",{style:"currency",currency:"IDR",maximumFractionDigits:0}).format(n);
const date=x=>new Date(x).toLocaleString("id-ID",{dateStyle:"medium",timeStyle:"short"});
async function api(url,opt={}){
  opt.headers={...(opt.headers||{}),Authorization:`Bearer ${token}`,"Content-Type":"application/json"};
  const r=await fetch(url,opt),d=await r.json();
  if(!r.ok)throw Error(d.error||"Terjadi kesalahan");
  return d;
}
function toast(text){
  $("toast").textContent=text;$("toast").classList.add("show");
  setTimeout(()=>$("toast").classList.remove("show"),2600);
}
$("loginForm").onsubmit=async e=>{
  e.preventDefault();
  try{
    const d=await api("/api/auth/login",{method:"POST",body:JSON.stringify({email:$("email").value,password:$("password").value})});
    localStorage.setItem("wa_rental_token",d.token);token=d.token;render();
  }catch(err){$("loginError").textContent=err.message}
};
$("logout").onclick=()=>{localStorage.removeItem("wa_rental_token");location.reload()};
async function render(){
  if(!token)return;
  try{
    const d=await api("/api/dashboard");
    $("loginPage").hidden=true;$("app").hidden=false;
    $("userName").textContent=d.user.name;$("hello").textContent=d.user.name;
    $("userRole").textContent=d.user.role==="admin"?"Administrator":"Member";
    $("balance").textContent=money(d.user.balance);
    $("total").textContent=d.stats.totalDevices;$("available").textContent=d.stats.available+" tersedia";
    $("rented").textContent=d.stats.rented;$("active").textContent=d.stats.myActive;
    $("devices").innerHTML=d.devices.map(x=>`
      <div class="device">
        <div class="device-info"><b>${x.name}</b><small>${x.code} · ${x.status==="available"?"Siap disewa":"Sedang digunakan"}</small></div>
        <div class="device-action">
          <span class="price">${money(x.price_per_day)}/hari</span>
          ${x.status==="available"?`<button class="rent" onclick="rent(${x.id})">Sewa</button>`:`<span class="disabled">Tidak tersedia</span>`}
        </div>
      </div>`).join("");
    $("rentals").innerHTML=d.rentals.length?d.rentals.slice(0,8).map(x=>`
      <div class="rental"><div><b>${x.name}</b><small>${x.status==="active"?"Berakhir":"Berakhir pada"} · ${date(x.expires_at)}</small></div><span class="disabled">${x.status}</span></div>`).join(""):`<div class="empty">Belum ada rental.</div>`;
  }catch(e){localStorage.removeItem("wa_rental_token");location.reload()}
}
async function rent(id){
  const days=Number(prompt("Durasi rental (1-30 hari):","1"));
  if(!Number.isInteger(days)||days<1||days>30)return;
  try{
    await api("/api/rentals",{method:"POST",body:JSON.stringify({deviceId:id,days})});
    toast("Rental berhasil dibuat. Sistem akan expire otomatis.");
    render();
  }catch(e){toast(e.message)}
}
render();
setInterval(()=>{if(token)render()},30000);
