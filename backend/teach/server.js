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

const menu = {
    1: {
        item: "burger",
        price: 50,
        time: 5
    },
    2: {
        item: "cola",
        price: 5,
        time: 1
    },
    3: {
        item: "fires",
        price: 15,
        time: 5
    },
}

let stock = 5;

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

// function Token(item){
//    return new Promise((resolve, reject) => {
//         setTimeout(() => {
//             if (stock > 0) {
//                 resolve(item);
//             } else {
//                 reject("refund ,no stock avalible")
//             }
//         }, 1000);
//     });
// }
// async function orderFood(item){
//     try{
//         console.log(item);

//         const mes= await Token(item);

//         console.log(`your ${mes.item}:${mes.price}`);
//         console.log( `your ${mes.item} is  being packed`);
//         console.log(`It takes ${mes.time}`) ;
//         stock--;
//         console.log(stock);

//     }catch(error){
//         console.log(error);
//     }finally{
//         console.log("have a good day");
//     }
// }

// const s=orderFood(menu[1]);
// const p=orderFood(menu[2]);
// console.log(s,p);


// function orderCoffey(){
//     return new Promise((resolve)=>{
//         setTimeout(() => {
//             console.log("order coffee")
//             resolve();
//         }, 3000);
//     }).then(()=>{
//          return new Promise((resolve)=>{ 
//            setTimeout(() => {
//              console.log("pay for coffee");
//              resolve();
//            }, 3000);})
//     })
//     .then(()=>{
//         return new Promise((resolve)=>{
//            setTimeout(() => {
            
//              console.log("drink coffee");
//              resolve();
//            }, 3000);})
//     })
//     .then(()=>{
        
//            setTimeout(() => {
//              console.log("enjoy");
//            }, 3000);})
    
// }

function wait(){
    return new Promise((resolve)=>{
        setTimeout(resolve,3000);
    })
}
async function orderCoffey() {


    console.log("order coffee");
    await wait();

    console.log("pay for coffee");
    await wait();

    console.log("drink coffee");
    await wait();

    console.log("enjoy");

}
orderCoffey();