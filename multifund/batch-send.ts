import { 
    Connection,
    PublicKey,
    Keypair,
    Transaction,
    SystemProgram,
    LAMPORTS_PER_SOL,
    sendAndConfirmTransaction,
} from "@solana/web3.js";

const fs = require('fs');

/*
    USAGE:
    ts-node batch-send.ts <NETWORK> <AMOUNT>

    # mainnet:      ts-node batch-send.ts mainnet max
    # devnet:       ts-node batch-send.ts devnet max
    # localnet:     ts-node batch-send.ts localnet max
*/

const env_parse = require("dotenv").config();                 // load config file
const [env] = process.argv.slice(2);        // cli arg for mainnet/devnet/localnet
const [amt] = process.argv.slice(3);        // cli arg for amount to distribute ("max" or integer)

// snag private key, rpc endpoints, and the list of dest addrs from the .env file
const PRIVKEY: string = process.env["private_key"];
const MAINNET_RPC: string = process.env["mainnetRPC"];
const DEVNET_RPC: string = process.env["devnetRPC"];
const LOCALNET_RPC: string = process.env["localnetRPC"];
const CSV_PATH: string = process.env["csv_path"];

const NUM_TEST_PAYEES: number = 10;
const FEES_PER_TRANSFER: number = 2000;                 // I think this is ballpark accurate idk
const MAX_INSTRUCTIONS_PER_TX: number = 20;             // compute constraints


function generate_payees (num_accounts: number): Array<PublicKey> {
    let payees: Array<PublicKey> = [];
    for(let _i: number = 0 ; _i < num_accounts ; _i++) {
        let k: Keypair = Keypair.generate();
        payees.push(k.publicKey);
    }
    return payees;
}

function payees_from_csv (path: string): Array<PublicKey> {
    let payees: Array<PublicKey> = [];
    let data = fs.readFileSync(path)
        .toString() // convert Buffer to string
        .split('\n') // split string to lines
        .map(e => e.trim()); // remove white spaces for each line
    
    for (let addr of data){
        payees.push(new PublicKey(addr));
    }
    return payees;
}

const main = async () => {
    // pull in a private key from the .env file and setup the web3js keypair
    const fromKeypair = Keypair.fromSecretKey( Uint8Array.from(JSON.parse(PRIVKEY)) );
    console.log("payer address:\t%s", fromKeypair.publicKey);

    // set up connection to the respective RPC node according to user's cli argument
    let active_rpc: string;
    switch (env) {
        case "mainnet":
            active_rpc = MAINNET_RPC;
            break;
        case "devnet":
            active_rpc = DEVNET_RPC;
            break;
        case "localnet":
            active_rpc = LOCALNET_RPC;
            break;
        default:
            active_rpc = LOCALNET_RPC;
    }
    console.log("active RPC:\t%s (%s)", active_rpc, env);
    const connection = new Connection(active_rpc);

    // get the payer's balance
    let payerBalance = await connection.getBalance(fromKeypair.publicKey);
    console.log("payer balance:\t%s SOL\n", payerBalance / LAMPORTS_PER_SOL);

    // get the list of accounts we want to send to
    let payees: Array<PublicKey>;
    if ( env != "mainnet" ) {
        // if testing on local/devnet, make new test accounts
        payees = generate_payees(NUM_TEST_PAYEES);
    } else {
        // if we're on mainnet, use a CSV
        payees = payees_from_csv(CSV_PATH);
    }

    // calculate the total amount to send, and the amount each payee wil recieve
    const EST_TX_COST: number = payees.length * FEES_PER_TRANSFER;
    const DISTRIBUTION_AMOUNT: number = (amt == "max") ? 
                                        payerBalance - EST_TX_COST : Number(amt) * LAMPORTS_PER_SOL;
    const LAMPORTS_PER_ADDR: number = Math.floor(DISTRIBUTION_AMOUNT / payees.length);
    if (LAMPORTS_PER_ADDR <= 0) { 
        console.log("distribution insufficient to cover tx fees; exiting...")
        process.exit(1);
    }

    // make sure the payer is solvent for the desired distribution amount
    if ( payerBalance < DISTRIBUTION_AMOUNT + EST_TX_COST) {
        if ( env != "mainnet" )  {
            // if we're not on mainnet, request a solana airdrop
            console.log("insufficient SOL balance; requesting %s SOL airdrop...\n", 
                        (DISTRIBUTION_AMOUNT - payerBalance)/LAMPORTS_PER_SOL);
            let airdropSignature = await connection.requestAirdrop(
                fromKeypair.publicKey,
                DISTRIBUTION_AMOUNT + EST_TX_COST - payerBalance,
            );
            let result = await connection.confirmTransaction(airdropSignature);
        } else {
            // if we're on mainnet, inform the user of insufficient balance
            console.log("insufficient balance for distribution... ");
            console.log("requested:\t%s\navailable:\t%s", DISTRIBUTION_AMOUNT, payerBalance);
            process.exit(1);
        }
    }

    // log balances and addresses of destination accounts
    console.log("distributing %s SOL (%s each) to:",
                DISTRIBUTION_AMOUNT / LAMPORTS_PER_SOL,
                LAMPORTS_PER_ADDR / LAMPORTS_PER_SOL);

    let count: number = 1;
    for (let payee of payees) {
        let key: string = payee.toString();
        let pre_balance: number = await connection.getBalance(payee) / LAMPORTS_PER_SOL;
        let post_balance: number = pre_balance + (LAMPORTS_PER_ADDR / LAMPORTS_PER_SOL);
        console.log("[%s] %s (%s --> %s)", count, key, pre_balance, post_balance);
        count++;
    }

    // form the transactions in groups of 20 with transfers to each dest addr
    let txs: Array<Transaction> = [];
    for (let i: number = 0 ; i < payees.length ; i++ ) {
        if (i % MAX_INSTRUCTIONS_PER_TX == 0) {
            txs.push(new Transaction);
        }
        txs[txs.length - 1].add(
            SystemProgram.transfer({
                fromPubkey: fromKeypair.publicKey,
                toPubkey: payees[i],
                lamports: LAMPORTS_PER_ADDR,
            })
        );
    }
    
    // send the full transaction
    let txcount: number = 1;
    for (let transaction of txs){
        sendAndConfirmTransaction(
            connection,
            transaction,
            [fromKeypair]
        );
        console.log("sending transaction %s/%s", txcount, txs.length);
        txcount++;
    }
}


main();
