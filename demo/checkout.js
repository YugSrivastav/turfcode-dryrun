// demo/checkout.js

export function calculateTotal(order, user, options = {}) {
    let subtotal = 0;
    
    // Calculate subtotal from items
    if (order && order.items) {
        for (const item of order.items) {
            subtotal += item.price * item.quantity;
        }
    }

    // Standard tax (8%)
    const tax = subtotal * 0.08;

    // Shipping fee
    let shipping = 10.00;
    if (subtotal > 50) {
        shipping = 0.00; // Free shipping over $50
    }

    let total = subtotal + tax + shipping;

    return {
        subtotal: subtotal.toFixed(2),
        tax: tax.toFixed(2),
        shipping: shipping.toFixed(2),
        total: total.toFixed(2),
        currency: 'USD'
    };
}
