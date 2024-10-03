
const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const mysql = require('mysql2');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');


const app = express();

app.use(cors()); // Enable CORS for cross-origin requests
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));


// MySQL Database Connection
// const db = mysql.createConnection({
//   host: 'localhost',
//   user: 'root', // Replace with your MySQL username
//   password: 'root', // Replace with your MySQL password
//   database: 'waybill_tracker' // Replace with your database name
// });

const db = mysql.createPool({
  host: '193.203.184.74',
  user: 'u534462265_courier', // Replace with your MySQL username
  password: 'ASGlobal@12345', // Replace with your MySQL password
  database: 'u534462265_courier', // Replace with your database name
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});



db.getConnection((err, connection) => {
  if (err) {
    console.error('Error connecting to the database:', err);
    return;
  }
  console.log('Connected to the database');

  // Release the connection back to the pool
  connection.release();
});



// Configure Multer for File Uploads
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// User registration (hashing password)
const username = 'Admin'; 
const password = 'Admin'; 

bcrypt.hash(password, 10, (err, hashedPassword) => {
  if (err) {
    console.error('Error hashing password:', err);
    return;
  }

  db.query('SELECT * FROM users WHERE username = ?', [username], (err, results) => {
    if (err) {
      console.error('Error checking user existence:', err);
      return;
    }

    if (results.length > 0) {
      console.log('User already exists!');
      return;
    }

    db.query('INSERT INTO users (username, password) VALUES (?, ?)', [username, hashedPassword], (err) => {
      if (err) {
        console.error('Error inserting user into database:', err);
      } else {
        console.log('User created successfully!');
      }
    });
  });
});
// Login Endpoint
app.post('/login', (req, res) => {
  const { username, password } = req.body;

  db.query('SELECT * FROM users WHERE username = ?', [username], async (err, results) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }

    if (results.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const user = results[0];
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = jwt.sign({ id: user.id, username: user.username }, 'lokananthan', { expiresIn: '5h' });
    res.json({ token });
  });
});

// Middleware to protect routes
const authenticateToken = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];

  if (!token) {
    return res.sendStatus(401);
  }

  jwt.verify(token, 'lokananthan', (err, user) => {
    if (err) {
      return res.sendStatus(403);
    }
    req.user = user;
    next();
  });
};


const headerNames = {
  waybill_no: ['CONNOTE NO'],
  order_id: ['ORDER ID'],
  destination_city: ['DEST'],
  order_date: ['DATE'],
  weight: ['W-GMS']
};

// Function to get the index of the first matching header
const getHeaderIndex = (headers, fieldNames) => {
  for (const name of fieldNames) {
    const index = headers.indexOf(name);
    if (index !== -1) return index;
  }
  return -1; // Return -1 if no matching header is found
};

// Function to extract state code from destination city (e.g., "HYD TS" -> "TS")
const processStateCode = (destinationCity) => {
  // Trim and split the destinationCity into parts
  const parts = destinationCity.trim().split(' ');

  // Check if destination city is CBE or starts with CBE
  if (parts[0] === 'CBE') {
    return 'CBE';
  }

  // If there is only one word, take the first two characters
  if (parts.length === 1) {
    return parts[0].substring(0, 2);
  }

  // If there are multiple words, take the last part as the state code
  return parts[parts.length - 1];
};


// Endpoint to Upload Excel/CSV File
app.post('/upload', upload.single('file'), (req, res) => {
  console.log(req.body);
  
  const file = req.file;
  if (!file) {
    return res.status(400).send('No file uploaded');
  }

  let data = [];

  try {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      // Parse CSV file
      const csv = file.buffer.toString();
      const rows = csv.split('\n').filter(row => row.trim() !== '');
      const headers = rows[15].split(',').map(header => header.trim()); // Read the 16th row as headers
      const dataRows = rows.slice(16); // Start processing from the 17th row
    
      data = dataRows.map((row, rowIndex) => {
        const values = row.split(',').map(value => value.trim());

        // Ensure weight is a valid number
        const weightValue = parseFloat(values[getHeaderIndex(headers, headerNames.weight)]);
        if (isNaN(weightValue)) {
          console.warn(`Skipping row ${rowIndex + 17} due to invalid weight:, values[getHeaderIndex(headers, headerNames.weight)]`);
          return null; // Skip invalid rows
        }

        // Validate waybill_no to be an integer
        const waybillNo = parseInt(values[getHeaderIndex(headers, headerNames.waybill_no)], 10);
        if (isNaN(waybillNo)) {
          console.warn(`Skipping row ${rowIndex + 17} due to invalid waybill_no:, values[getHeaderIndex(headers, headerNames.waybill_no)]`);
          return null; // Skip invalid rows
        }

        // Validate order_id to ensure it is not empty
        const orderId = values[getHeaderIndex(headers, headerNames.order_id)] || '';
        if (!orderId.trim()) {
          console.warn(`Skipping row ${rowIndex + 17} due to empty order_id.`);
          return null; // Skip invalid rows
        }

        return {
          waybill_no: waybillNo,
          order_id: orderId,
          destination_city: values[getHeaderIndex(headers, headerNames.destination_city)] || '',
          order_date: new Date(values[getHeaderIndex(headers, headerNames.order_date)]) || null,
          weight: weightHeader === 'Wgt' ? weightValue * 1000 : weightValue // Convert kg to grams if header is 'Weight_kg'
        };
      }).filter(row => row !== null); // Remove any invalid rows
    } else {
      // Parse Excel file
      const workbook = xlsx.read(file.buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const jsonData = xlsx.utils.sheet_to_json(sheet, { raw: false, range: 15 }); // Start from the 16th row
    
      const weightHeader = headerNames.weight.find(name => name in jsonData[0]) || '';
      data = jsonData.map((row, rowIndex) => {
        const weightValue = parseFloat(row[weightHeader]);
        if (isNaN(weightValue)) {
          console.warn(`Skipping row ${rowIndex + 17} due to invalid weight:, row[weightHeader]`);
          return null; // Skip invalid rows
        }

        // Validate waybill_no to be an integer
        const waybillNo = parseInt(row[headerNames.waybill_no.find(name => name in row)], 10);
        if (isNaN(waybillNo)) {
          console.warn(`Skipping row ${rowIndex + 17} due to invalid waybill_no:, row[headerNames.waybill_no]`);
          return null; // Skip invalid rows
        }

        // Validate order_id to ensure it is not empty
        const orderId = row[headerNames.order_id.find(name => name in row)] || '';
        if (!orderId.trim()) {
          console.warn(`Skipping row ${rowIndex + 17} due to empty order_id.`);
          return null; // Skip invalid rows
        }

        return {
          waybill_no: waybillNo,
          order_id: orderId,
          destination_city: row[headerNames.destination_city.find(name => name in row)] || '',
          order_date: new Date(row[headerNames.order_date.find(name => name in row)] || '') || null,
          weight: weightHeader === 'Wgt' ? weightValue * 1000 : weightValue // Convert kg to grams if column is 'Weight_kg'
        };
      }).filter(row => row !== null); // Remove any invalid rows
    }
  } catch (err) {
    console.error('Error parsing file:', err);
    return res.status(400).send('Error parsing file');
  }

  const ratesPath = path.join(__dirname, 'rates.json');
  const loadRates = () => {
    const ratesData = fs.readFileSync(ratesPath, 'utf-8');
    return JSON.parse(ratesData);
  };
  
  const saveRates = (newRates) => {
    fs.writeFileSync(ratesPath, JSON.stringify(newRates, null, 2), 'utf-8');
  };
  
  // Load rates from rates.json
  app.get('/rates', (req, res) => {
    try {
      const rates = loadRates();
      res.json(rates);
    } catch (err) {
      console.error('Error loading rates:', err);
      res.status(500).json({ error: 'Failed to load rates' });
    }
  });
  
  // Update rates in rates.json
  app.put('/rates', authenticateToken, (req, res) => {
    try {
      const newRates = req.body;
      saveRates(newRates);
      res.json({ message: 'Rates updated successfully' });
    } catch (err) {
      console.error('Error updating rates:', err);
      res.status(500).json({ error: 'Failed to update rates' });
    }
  });

  // Function to calculate amount based on weight and region
  const calculateAmount = (weight, region) => {
    const rates = loadRates();
    const rate = rates[region];

    if (!rate) {
      console.warn(`Unknown or missing region: ${region}. Setting total amount to 0.`);
      return 0;
    }

    const { amount250, amount1000, additional500 } = rate;
    let totalAmount = 0;

    if (weight <= 250) {
      totalAmount = amount250;
    } else if (weight <= 1000) {
      totalAmount = amount1000;
    } else if (weight <= 1500) {
      totalAmount = amount1000 + additional500;
    } else {
      const weightStr = weight.toString().padStart(6, '0');
      const lastThree = parseInt(weightStr.slice(-3), 10);
      const remaining = parseInt(weightStr.slice(0, -3), 10) || 0;

      if (lastThree === 0) {
        totalAmount = remaining * amount1000;
      } else if (lastThree <= 500) {
        totalAmount = (remaining * amount1000) + additional500;
      } else {
        totalAmount = (remaining + 1) * amount1000;
      }
    }

    return totalAmount;
  };

  // Fetch state_code and region from weights table
  db.query('SELECT state_code, region FROM weights', (err, weightResults) => {
    if (err) {
      console.error('Error fetching weights data:', err);
      return res.status(500).send('Error fetching weights data');
    }

    const weightMap = weightResults.reduce((acc, row) => {
      acc[row.state_code] = row.region; // Map state code to region
      return acc;
    }, {});

    // Calculate Amount and prepare data for insertion
    const processedData = data.map(item => {
      const stateCode = processStateCode(item.destination_city); // Extract state code from uploaded file
      const region = weightMap[stateCode] || null; // Get the region based on state code

      const amount = calculateAmount(item.weight, region); // Calculate the amount using the weight and region
      
      return {
        ...item,
        amount,
        destination_city: item.destination_city // Keep the full destination city (e.g., "HYD TS")
      };
    });

    // Delete existing data from waybills table
    db.query('DELETE FROM waybills', (err) => {
      if (err) {
        console.error('Error deleting old data from waybills:', err);
        return res.status(500).send('Error deleting old data from waybills');
      }

      // Insert new data into MySQL
      const query = 'INSERT INTO waybills (waybill_no, order_id, destination_city, order_date, weight, amount) VALUES ?';
      const values = processedData.map(item => [
        item.waybill_no,
        item.order_id,
        item.destination_city,
        item.order_date,
        item.weight,
        item.amount
      ]);
      
      db.query(query, [values], (err) => {
        if (err) {
          console.error('Error inserting data into MySQL:', err);
          return res.status(500).send('Error inserting data into database');
        }
        console.log('Data inserted successfully');
        res.json(processedData);
      });
    });
  });
});

// Endpoint to Retrieve Data from MySQL
app.get('/waybills', (req, res) => {
  const query = 'SELECT waybill_no, order_id, destination_city, order_date, weight, amount FROM waybills';

  db.query(query, (err, results) => {
    if (err) {
      console.error('Error fetching data from MySQL:', err);
      return res.status(500).send('Error fetching data from database');
    }
    res.json(results);
  });
});

// Endpoint to Edit a Record
app.put('/waybills/:waybill_no', (req, res) => {
  const { waybill_no } = req.params;
  const { order_id, destination_city, order_date, weight, amount } = req.body;

  const query = 
    `UPDATE waybills
    SET order_id = ?, destination_city = ?, order_date = ?, weight = ?, amount = ?
    WHERE waybill_no = ?`
  ;
  
  db.query(query, [order_id, destination_city, new Date(order_date), weight, amount, waybill_no], (err) => {
    if (err) {
      console.error('Error updating record:', err);
      return res.status(500).json({ error: 'Error updating record' });
    }
    res.json({ message: 'Record updated successfully' });
  });
});

// Endpoint to Delete a Record
app.delete('/waybills/:waybill_no', (req, res) => {
  const { waybill_no } = req.params;

  const query = 'DELETE FROM waybills WHERE waybill_no = ?';

  db.query(query, [waybill_no], (err) => {
    if (err) {
      console.error('Error deleting record:', err);
      return res.status(500).json({ error: 'Error deleting record' });
    }
    res.json({ message: 'Record deleted successfully' });
  });
});

app.put('/weights/:id', (req, res) => {
  const { id } = req.params;
  const { state_code, region } = req.body;
  const query = 'UPDATE weights SET  state_code = ?, region = ? WHERE id = ?';
  db.query(query, [state_code, region, id], (err, result) => {
    if (err) {
      console.error('Error updating data:', err);
      return res.status(500).send('Server Error');
    }
    res.status(200).send(result);
  });
});

app.delete('/weights/:id', (req, res) => {
  const { id } = req.params;
  const query = 'DELETE FROM weights WHERE id = ?';
  db.query(query, [id], (err) => {
    if (err) {
      console.error('Error deleting weight entry:', err);
      return res.status(500).send('Error deleting weight entry');
    }
    res.send('Weight entry deleted successfully');
  });
});

// Endpoint to Add Weight Entries
app.post('/weights', (req, res) => {
  const { state_code, region } = req.body;

  const query = 'INSERT INTO weights (state_code, region) VALUES (?, ?)';
  db.query(query, [state_code, region], (err) => {
    if (err) {
      console.error('Error inserting weight entry:', err);
      return res.status(500).send('Error inserting weight entry');
    }
    res.send('Weight entry added successfully');
  });
});

// Endpoint to Retrieve Weight Entries
app.get('/weights', (req, res) => {
  const query = 'SELECT id, state_code, region FROM weights';
  db.query(query, (err, results) => {
    if (err) {
      console.error('Error fetching weight entries from MySQL:', err);
      return res.status(500).send('Error fetching weight entries');
    }
    res.json(results);
  });
});


// Function to delete old records from export_data
const deleteOldExportData = () => {
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

  const formattedDate = threeMonthsAgo.toISOString().split('T')[0]; // Format date as YYYY-MM-DD

  const deleteQuery = 'DELETE FROM export_data WHERE Date < ?';
  db.query(deleteQuery, [formattedDate], (err, result) => {
    if (err) {
      console.error('Error deleting old export data:', err);
    } else {
      console.log(`Deleted ${result.affectedRows} records older than ${formattedDate}`);
    }
  });
};



// Endpoint to save exported data
app.post('/api/save-exported-data', (req, res) => {
  const { exportData } = req.body;

  if (!exportData || !Array.isArray(exportData) || exportData.length === 0) {
    return res.status(400).json({ error: 'Invalid export data' });
  }

  const uniqueIds = exportData.map(record => record.Cannote_No);

  // Check for duplicate Cannote_No in export_data
  const checkDuplicateQuery = 'SELECT Cannote_No FROM export_data WHERE Cannote_No IN (?)';

  db.query(checkDuplicateQuery, [uniqueIds], (checkErr, duplicateResults) => {
    if (checkErr) {
      console.error('Error checking for duplicates:', checkErr);
      return res.status(500).json({ error: 'Database error while checking duplicates' });
    }

    const duplicateCannoteNumbers = duplicateResults.map(result => result.Cannote_No);

    if (duplicateCannoteNumbers.length > 0) {
      // Return duplicates to the frontend and stop further operations
      return res.status(200).json({ duplicates: duplicateCannoteNumbers });
    }

    // No duplicates, proceed with delete and insert
    const deleteExportDataQuery = 'DELETE FROM export_data WHERE Cannote_No IN (?)';
    db.query(deleteExportDataQuery, [uniqueIds], (deleteErr, deleteResult) => {
      if (deleteErr) {
        console.error('Error deleting existing data:', deleteErr);
        return res.status(500).json({ error: 'Error deleting existing data' });
      }

      console.log(`Deleted ${deleteResult.affectedRows} records with Cannote_No: ${uniqueIds.join(', ')}`);

      // Insert or update new data into export_data
      const exportQuery = `
        INSERT INTO export_data (S_No, Date, Order_ID, Cannote_No, Destination, Weight, RS_PS)
        VALUES ?
        ON DUPLICATE KEY UPDATE 
          Date = VALUES(Date),
          Order_ID = VALUES(Order_ID),
          Cannote_No = VALUES(Cannote_No),
          Destination = VALUES(Destination),
          Weight = VALUES(Weight),
          RS_PS = VALUES(RS_PS)`;

      const exportValues = exportData.map(record => [
        record.S_No,
        record.Date,
        record.Order_ID,
        record.Cannote_No,
        record.Destination,
        record.Weight,
        record.RS_PS
      ]);

      db.query(exportQuery, [exportValues], (insertErr) => {
        if (insertErr) {
          console.error('Error inserting or updating exported data:', insertErr);
          return res.status(500).json({ error: 'Error inserting or updating exported data' });
        }

        console.log('Data saved successfully');

        // Delete corresponding waybills data
        const deleteWaybillsQuery = 'DELETE FROM waybills WHERE waybill_no IN (?)';
        db.query(deleteWaybillsQuery, [uniqueIds], (waybillDeleteErr, waybillDeleteResult) => {
          if (waybillDeleteErr) {
            console.error('Error deleting waybills data:', waybillDeleteErr);
            return res.status(500).json({ error: 'Error deleting waybills data' });
          }

          console.log(`Deleted ${waybillDeleteResult.affectedRows} waybill records`);
          res.status(200).json({ message: 'Data saved successfully' });
        });
      });
    });
  });
});



app.get('/api/get-exported-data', (req, res) => {
  const { startDate, endDate, month, year } = req.query;

  let query = 'SELECT * FROM export_data';
  const queryParams = [];

  if (startDate && endDate) {
    query += ' WHERE Date BETWEEN ? AND ?';
    queryParams.push(startDate, endDate);
  } else if (month && year) {
    query += ' WHERE MONTH(Date) = ? AND YEAR(Date) = ?';
    queryParams.push(month, year);
  }

  db.query(query, queryParams, (err, results) => {
    if (err) {
      console.error('Error retrieving exported data:', err);
      return res.status(500).json({ error: 'Error retrieving exported data' });
    }

    res.status(200).json(results);
  });
});



// other clients


app.get('/weights/region', (req, res) => {
  const { destination_city } = req.query;
  let state_code;

  // Define special cases for specific city codes
  const specialCases = {
    CBE: "CBE", // Handle "CBE" or "CBE TN"
  };

  // Trim the destination city input
  const trimmedCity = destination_city.trim();

  // Check for the presence of special cases in the input
  if (trimmedCity.includes("CBE")) {
    state_code = "CBE";
  } else if (/\s/.test(trimmedCity)) {
    // Split by space and take the last word
    const words = trimmedCity.split(' ').filter(Boolean);
    const lastWord = words[words.length - 1].trim();
    state_code = lastWord.substring(lastWord.length - 2);
  } else {
    // If no spaces, take the first two characters
    state_code = trimmedCity.substring(0, 2).trim();
  }

  console.log('Destination City:', destination_city);
  console.log('Derived State Code:', state_code);

  const query = 'SELECT region FROM weights WHERE state_code = ?';
  db.query(query, [state_code], (err, results) => {
    if (err) {
      console.error('Error fetching region:', err);
      return res.status(500).send('Server Error');
    }
    if (results.length > 0) {
      console.log('Selected Region:', results[0].region);
      res.json(results[0]);
    } else {
      res.status(404).send('Region not found');
    }
  });
});





// Endpoint to Retrieve Rates Based on Destination City
// Create a new client
app.post('/api/clients', (req, res) => {
  const { client_name, Address, GST_no } = req.body;
  const sql = 'INSERT INTO clients (client_name, Address, GST_no) VALUES (?, ?, ?)';
  db.query(sql, [client_name, Address, GST_no], (err, result) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to create client' });
    }
    res.json({ insertId: result.insertId });
  });
});


// Create or update rates for a client
app.post('/api/other/rate', (req, res) => {
  const { region, amount250, amount1000, client_id } = req.body;
  const sql = 'INSERT INTO rate (region, amount250, amount1000, client_id) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE amount250 = VALUES(amount250), amount1000 = VALUES(amount1000)';
  db.query(sql, [region, amount250, amount1000, client_id], (err, result) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to assign rate' });
    }
    res.json({ message: 'Rate assigned successfully' });
  });
});


app.get('/api/other/rate/:clientId', (req, res) => {
  const { clientId } = req.params;
  const region = req.query.region; // Ensure you're passing the region in the query parameters

  const sql = 'SELECT * FROM rate WHERE client_id = ? AND region = ?';
  db.query(sql, [clientId, region], (err, result) => {
    if (err) {
      console.error('Error fetching rates:', err);
      return res.status(500).json({ error: 'Failed to fetch rates' });
    }
    console.log('Selected Client ID:', clientId);
    console.log('Rates fetched:', result);
    res.json(result);
  });
});



// Update an existing client
app.put('/api/clients/:id', (req, res) => {
  const { id } = req.params;
  const { client_name, Address, GST_no } = req.body;
  const sql = 'UPDATE clients SET client_name = ?, Address = ?, GST_no = ? WHERE id = ?';
  db.query(sql, [client_name, Address, GST_no, id], (err, result) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to update client' });
    }
    res.json({ message: 'Client updated successfully' });
  });
});

// Delete a client and their rates
app.delete('/api/clients/:id', (req, res) => {
  const clientId = req.params.id;

  // Start a transaction to ensure both deletions are successful
  connection.beginTransaction(err => {
    if (err) {
      console.error('Error starting transaction:', err);
      return res.status(500).send('Error starting transaction');
    }

    // Delete associated rates first
    db.query('DELETE FROM rate WHERE client_id = ?', [clientId], (err, result) => {
      if (err) {
        connection.rollback(() => {
          console.error('Error deleting rate:', err);
          return res.status(500).send('Error deleting rates');
        });
      } else {
        // If rates deletion is successful, delete the client
        db.query('DELETE FROM clients WHERE id = ?', [clientId], (err, result) => {
          if (err) {
            connection.rollback(() => {
              console.error('Error deleting client:', err);
              return res.status(500).send('Error deleting client');
            });
          } else {
            connection.commit(err => {
              if (err) {
                connection.rollback(() => {
                  console.error('Error committing transaction:', err);
                  return res.status(500).send('Error committing transaction');
                });
              } else {
                res.sendStatus(200); // Successfully deleted client and rates
              }
            });
          }
        });
      }
    });
  });
});

// Delete rates for a client
app.delete('/api/other/rate/:clientId', (req, res) => {
  const { clientId } = req.params;
  const sql = 'DELETE FROM rate WHERE client_id = ?';
  db.query(sql, [clientId], (err, result) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to delete rates' });
    }
    res.json({ message: 'Rates deleted successfully' });
  });
});


app.get('/api/clients', (req, res) => {
  // Update the query to select id, client_name, Address, and GST_no
  const query = 'SELECT id, client_name, Address, GST_no FROM clients';
  db.query(query, (err, results) => {
    if (err) {
      console.error('Error fetching clients:', err);
      return res.status(500).send('Error fetching clients');
    }
    res.json(results);
  });
});

// Get client details by ID
app.get('/api/clients/:id', (req, res) => {
  const { id } = req.params;
  const sql = 'SELECT client_name, Address, GST_no FROM clients WHERE id = ?';
  db.query(sql, [id], (err, results) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to fetch client details' });
    }
    if (results.length > 0) {
      res.json(results[0]);
    } else {
      res.status(404).json({ error: 'Client not found' });
    }
  });
});


app.post('/api/saveData', (req, res) => {
  const { clientId, clientName, clientAddress, gstNumber, tableData } = req.body;

  // Get a connection from the pool
  db.getConnection((err, connection) => {
    if (err) {
      console.error('Error getting connection from pool:', err);
      return res.status(500).json({ error: 'Failed to get connection' });
    }

    connection.beginTransaction((err) => {
      if (err) {
        console.error('Error starting transaction:', err);
        connection.release(); // Release connection on error
        return res.status(500).json({ error: 'Failed to start transaction' });
      }

      const clientData = [clientId, clientName, clientAddress, gstNumber];

      const cannoteNos = tableData.map((row) => row.Cannote_No);
      connection.query('SELECT Cannote_No FROM invoice_items WHERE Cannote_No IN (?)', [cannoteNos], (err, results) => {
        if (err) {
          return connection.rollback(() => {
            console.error('Error checking Cannote_No:', err);
            connection.release(); // Release connection on error
            return res.status(500).json({ error: 'Failed to check Cannote_No' });
          });
        }

        const existingCannoteNos = results.map((result) => result.Cannote_No);

        // Filter out the duplicates
        const newRows = tableData.filter(row => !existingCannoteNos.includes(row.Cannote_No));

        if (newRows.length === 0) {
          // If all rows are duplicates, send the conflict message
          connection.release(); // Release connection
          return res.status(409).json({
            message: 'Duplicate Cannote_No found. No new data was inserted.',
            existingCannoteNos
          });
        }

        // Proceed to insert only the new records
        const insertRows = newRows.map(row => [
          row.Cannote_No,
          row.Date,
          row.Destination,
          row.Weight,
          row.RS_PS,
          clientId
        ]);

        connection.query('INSERT INTO invoice_items (Cannote_No, Date, Destination, Weight, RS_PS, client_id) VALUES ?', [insertRows], (err) => {
          if (err) {
            return connection.rollback(() => {
              console.error('Error inserting rows:', err);
              connection.release(); // Release connection on error
              return res.status(500).json({ error: 'Failed to save data' });
            });
          }

          connection.commit((err) => {
            if (err) {
              return connection.rollback(() => {
                console.error('Error committing transaction:', err);
                connection.release(); // Release connection on error
                return res.status(500).json({ error: 'Failed to commit transaction' });
              });
            }

            // Release connection after successful commit
            connection.release(); 
            // Send response with success message and list of duplicates (if any)
            res.status(200).json({
              message: 'Data saved successfully',
              duplicates: existingCannoteNos.length > 0 ? existingCannoteNos : null
            });
          });
        });
      });
    });
  });
});


// Update invoice items if duplicate found
app.put('/api/updateData', (req, res) => {
  const { clientId, tableData } = req.body;

  const tableRows = tableData.map((row) => [
    row.Date,
    row.Destination,
    row.Weight,
    row.RS_PS,
    clientId,
    row.Cannote_No, // Using Cannote_No to identify row for update
  ]);

  const query = `
    UPDATE invoice_items
    SET Date = ?, Destination = ?, Weight = ?, RS_PS = ?
    WHERE client_id = ? AND Cannote_No = ?
  `;

  db.query(query, [tableRows], (err) => {
    if (err) {
      console.error('Error updating invoice items:', err);
      return res.status(500).json({ error: 'Failed to update invoice items' });
    }

    res.status(200).json({ message: 'Data updated successfully' });
  });
});




// Endpoint to fetch client options
app.get('/api/getClientOptions', (req, res) => {
  const query = 'SELECT id, client_name AS name FROM clients'; // Adjust column name here
  db.query(query, (err, results) => {
    if (err) {
      console.error('Error fetching client options:', err);
      return res.status(500).json({ error: 'Failed to fetch client options' });
    }
    console.log('Client options:', results); // Log results to verify
    res.status(200).json(results);
  });
});


app.post('/api/getFilteredData', (req, res) => {
  const { clientId, month, year, startDate, endDate } = req.body;
  let query = `
    SELECT clients.client_name, invoice_items.* 
    FROM clients 
    INNER JOIN invoice_items ON clients.id = invoice_items.client_id
    WHERE clients.id = ?
  `;
  const queryParams = [clientId];  // Now filtering by clientId

  if (month) {
    query += ' AND MONTH(invoice_items.Date) = ?';
    queryParams.push(month);
  }
  if (year) {
    query += ' AND YEAR(invoice_items.Date) = ?';
    queryParams.push(year);
  }
  if (startDate && endDate) {
    query += ' AND invoice_items.Date BETWEEN ? AND ?';
    queryParams.push(startDate, endDate);
  }

  db.query(query, queryParams, (err, results) => {
    if (err) {
      console.error('Error fetching filtered data:', err);
      return res.status(500).json({ error: 'Failed to fetch data' });
    }
    console.log('Filtered data:', results);
    res.status(200).json(results);
  });
});


// Endpoint to fetch client details by ID or name
app.post('/api/getClientDetails', (req, res) => {
  const { clientId } = req.body;
  
  // SQL query to fetch client details by ID
  const query = `SELECT client_name, Address, GST_no FROM clients WHERE id = ?`;

  db.query(query, [clientId], (error, results) => {
      if (error) {
          console.error('Error fetching client details:', error);
          return res.status(500).json({ error: 'Database error' });
      }
      
      if (results.length > 0) {
          // Send client details (client_name, Address, GST_no) as the response
          res.json(results[0]);
      } else {
          res.status(404).json({ error: 'Client not found' });
      }
  });
});



//rates
const ratesFilePath = path.join(__dirname, 'rates.json');

// Endpoint to get current rates
app.get('/api/rates', (req, res) => {
  fs.readFile(ratesFilePath, 'utf8', (err, data) => {
    if (err) {
      console.error('Error reading rates file:', err);
      return res.status(500).json({ error: 'Error reading rates file' });
    }
    res.json(JSON.parse(data));
  });
});

// Endpoint to update rates
app.post('/api/rates', authenticateToken, (req, res) => {
  const newRates = req.body;

  fs.writeFile(ratesFilePath, JSON.stringify(newRates, null, 2), 'utf8', (err) => {
    if (err) {
      console.error('Error writing to rates file:', err);
      return res.status(500).json({ error: 'Error saving rates' });
    }
    res.json({ message: 'Rates updated successfully!' });
  });
});


const cron = require('node-cron');

// Schedule a job to run every day at midnight
cron.schedule('0 0 * * *', () => {
  console.log('Running scheduled task to delete old records from invoice_items and export_data');

  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  const formattedDate = threeMonthsAgo.toISOString().split('T')[0]; // Format date as YYYY-MM-DD

  // Begin transaction to delete records older than 3 months
  db.beginTransaction((err) => {
    if (err) {
      console.error('Error starting transaction:', err);
      return;
    }

    // Delete from export_data first
    db.query(
      'DELETE FROM export_data WHERE Date < ?',
      [formattedDate],
      (err) => {
        if (err) {
          return db.rollback(() => {
            console.error('Error deleting old records from export_data:', err);
          });
        }

        // Now delete from invoice_items
        db.query(
          'DELETE FROM invoice_items WHERE Date < ?',
          [formattedDate],
          (err) => {
            if (err) {
              return db.rollback(() => {
                console.error('Error deleting old records from invoice_items:', err);
              });
            }

            // Commit the transaction if both deletions were successful
            db.commit((err) => {
              if (err) {
                return db.rollback(() => {
                  console.error('Error committing transaction:', err);
                });
              }
              console.log('Old records deleted successfully from invoice_items and export_data');
            });
          }
        );
      }
    );
  });
});


app.post('/companies', upload.single('logo'), (req, res) => {
  const { companyName, address, mobile1, mobile2, panNumber, gstNumber, logoName } = req.body;
  const logo = req.file;

  // Convert logo to base64
  const logoBase64 = logo ? logo.buffer.toString('base64') : null;

  // SQL query to insert company data, ensuring logoName is unique
  const sql = `INSERT INTO companies (companyName, address, mobile1, mobile2, panNumber, gstNumber, logoName, logo) 
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON DUPLICATE KEY UPDATE address=?, mobile1=?, mobile2=?, panNumber=?, gstNumber=?, logo=?`;

  db.query(sql, [companyName, address, mobile1, mobile2, panNumber, gstNumber, logoName, logoBase64, address, mobile1, mobile2, panNumber, gstNumber, logoBase64],
    (err, result) => {
      if (err) {
        console.error(err);
        return res.status(500).send('Error saving company data');
      }
      res.send('Company data saved successfully');
    });
});

app.get('/companies', (req, res) => {
  const sql = 'SELECT id, logoName FROM companies';
  db.query(sql, (err, result) => {
    if (err) {
      console.error(err);
      return res.status(500).send('Error fetching companies');
    }
    res.json(result);
  });
});

app.get('/api/companies/all', (req, res) => {
  const sql = 'SELECT id, companyName, address, mobile1, mobile2, panNumber, gstNumber, logo, logoName FROM companies';
  
  db.query(sql, (err, result) => {
    if (err) {
      console.error(err);
      return res.status(500).send('Error fetching companies');
    }
    
    // Assuming logos are stored in a folder named 'uploads'
    const companiesWithLogos = result.map(company => ({
      ...company,
      logoUrl: company.logo ? `http://localhost:5000/uploads/${company.logo}` : null, // Adjust the URL as necessary
    }));

    res.json(companiesWithLogos);
  });
});


app.get('/companies/:id', (req, res) => {
  const companyId = req.params.id;

  const sql = 'SELECT * FROM companies WHERE id = ?';
  db.query(sql, [companyId], (err, result) => {
    if (err) {
      console.error(err);
      return res.status(500).send('Error fetching company details');
    }
    if (result.length === 0) {
      return res.status(404).send('Company not found');
    }
    
    // If there's a logo, format it as a data URL for the frontend
    const company = result[0];
    if (company.logo) {
      company.logoUrl = `data:image/png;base64,${company.logo}`; // Assuming the logo is a PNG
    } else {
      company.logoUrl = null; // No logo present
    }

    res.json(company); // Return the company data including the logo URL
  });
});

app.put('/api/companies/:id', (req, res) => {
  const { id } = req.params;
  const { companyName, address, mobile1, mobile2, panNumber, gstNumber , logoName } = req.body;

  const sql = 'UPDATE companies SET companyName = ?, address = ?, mobile1 = ?, mobile2 = ?, panNumber = ?, gstNumber = ? , logoName = ?  WHERE id = ?';

  db.query(sql, [companyName, address, mobile1, mobile2, panNumber, gstNumber, id , logoName], (err, result) => {
    if (err) {
      console.error(err);
      return res.status(500).send('Error updating company');
    }
    res.send({ message: 'Company updated successfully' });
  });
});

app.delete('/api/companies/:id', (req, res) => {
  const { id } = req.params;
  const sql = 'DELETE FROM companies WHERE id = ?';

  db.query(sql, [id], (err, result) => {
    if (err) {
      console.error(err);
      return res.status(500).send('Error deleting company');
    }
    res.send({ message: 'Company deleted successfully' });
  });
});


const PORT = process.env.PORT || 5005;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});