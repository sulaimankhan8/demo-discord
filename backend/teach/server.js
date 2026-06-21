// function waitAndGreet(name,callback){
//     setTimeout(()=>{
//         callback(name,"hello","how are u");
//     },3000);
// }
// waitAndGreet("sulaiman",(name ,greet,mess)=>{console.log(greet,name,mess);});
// const promice1= new Promise((resolve, reject) =>{
//     const a= 16;

//     if(a>=18){
//         resolve("true");
//     }
//     else{
//         reject("false");
//     }

// })

// promice1.then(mes=>console.log(mes)).catch(err=>console.log(err)).finally(()=>console.log(`finaly `));



//1.burger
//fries etc



// const menu = {
//     1: {
//         item: "burger",
//         price: 50,
//         time: 5
//     },
//     2: {
//         item: "cola",
//         price: 5,
//         time: 1
//     },
//     3: {
//         item: "fires",
//         price: 15,
//         time: 5
//     },
// }

// let stock = 5;
// function orderFood(item) {

//     console.log(item);

//     const foodItem = new Promise((resolve, reject) => {


//         setTimeout(() => {
//             if (stock > 0) {

//                 resolve(item);
//             } else {
//                 reject("refund ,no stock avalible")
//             }
//         }, 1000);
//     });
//     console.log(foodItem);

//     return foodItem
//         .then(mes => { console.log(`your ${mes.item}:${mes.price}`); return mes; })
//         .then((mes1) => { console.log( `your ${mes1.item} is  being packed`); return mes1 })
//         .then((mes) => { console.log(`It takes ${mes.time}`) })
//         .catch(err => console.log(err))// for error handling
//         .finally(() => { console.log("have a good day"); stock--; console.log(stock); });// for clean up
// }
// const s=orderFood(menu[1]);
// console.log(s);



const name= "namrita";

/*name={
0:"n",
1:"a",
2:"m",
3:"r",
4:"i",
5:"t",
6:"a",
}*/
// let r="";
// let n=name.length;
// for(let i=0;i<n;i++){
//     r= r +name[n-i-1];
// }

// console.log(name,r);

// if(name===r){
//     console.log("p");
// }else{
//     console.log("n");
// }

// const n=5;
// let prim=true;
// for(let i=2;i<n;i++){
//     if(n%i === 0){
//         prim=false;
//         break;
//     }
//     else{
//         continue;
//     }
// }

// console.log(prim);

const arr=["oo","pp","kk"];
s="ooppkk";


for(let j=0;j<arr.length-1;j++){
for(let i=0;i<arr.length-1;i++){
    if(arr[i]>arr[i+1]){
        let temp=arr[i];
        arr[i]=arr[i+1];
        arr[i+1]=temp;
    }
}}
console.log(arr[arr.length-2]);